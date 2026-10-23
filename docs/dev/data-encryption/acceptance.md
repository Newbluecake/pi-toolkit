# 加密会话（pi-secure）真机验收清单

对应 [plan.md](./plan.md) §6「真机验收」与 §2.2–§2.5 的守护点。自动化覆盖在 `tests/secure/**`（含真 gocryptfs 的 `launcher-fuse.test.ts`）与 `tests/conformance/secure-gocryptfs.test.ts`；本清单覆盖**真机手动路径**。这是流程文档，不是「已验收」的声明：逐项勾选并记录实际输出，偏离预期即记 FAIL 与证据。

## 环境与准备

- [ ] Linux（本清单按 Ubuntu 22.04 编写），`gocryptfs --version` ≥ 1.8，`fusermount3`、`flock` 在 `/usr/bin`。
      预期：三条命令都有版本/路径输出；缺失时 `pi-secure init|unlock|run` 报 exit 69（`status` 照常输出并标出缺失项，`lock` 不做前置检查）。
- [ ] `pi-secure` 已安装（`ln -s <仓库路径>/src/secure/bin/pi-secure ~/.local/bin/pi-secure`；配置过保险库后 `/secure status` 也会打印它）。
      预期：`command -v pi-secure` 输出该符号链接；`pi-secure` 无参数时报用法（exit 2）。
- [ ] 准备金丝雀串：`CANARY=$(uuidgen)`（或手抄一个唯一串）。后续所有敏感写入都用它，最后做全盘 grep。
- [ ] 建议在普通（非加密）目录另开一个 pi 会话作对照组；两边的 `pi --version` 一致。

约定：下文 `<name>` 统一用示例名 `acme`；`<mnt>` = `~/secure/acme`（挂载点，0700 目录；未挂载时只含 `work`、`state` 两个 0 字节 0400 哨兵文件）；`<state>` = `~/secure/acme/state`；`<dir>` = `~/.local/share/pi-toolkit-secure/acme`（只放 cipher 与元数据）。

## A. init

- [ ] `pi-secure init acme`（**真实 TTY，不要在管道/重定向下跑**）。
      预期：提示输入两次新口令 → gocryptfs 在终端打印一次 master key（64 个十六进制字符，8 组 × 8）→ 首次挂载再提示一次口令 → 自动建目录、写项目 sessionDir → 结束时自动卸载 → 提示执行 `clear` / `tmux clear-history`。
- [ ] master key 已离线抄写保存（丢失口令且无 master key = 数据不可恢复）。
- [ ] `pi-secure status acme`。
      预期：`not mounted`（locked）· layout ok · mnt 列显示 `~/secure/acme`；无 gocryptfs/swap/core/traffic-record 异常告警（swap/core 视本机配置，可能有提示）。
- [ ] 登记与挂载点：`grep -n acme ~/.pi/agent/pi-subagent.json` 与 `ls -la ~/secure/acme`。
      预期：settings 里有 `secure.vaults.acme`（`{"dir":…, "mnt":…}`）；`~/secure/acme` 是 0700 目录而非符号链接，锁定时可 `cd ~/secure/acme`（内含 `work`、`state` 两个哨兵文件），`cd ~/secure/acme/work` 失败（ENOTDIR）。
- [ ] 反例：非 TTY 下 `echo | pi-secure init acme2`。
      预期：exit 2，提示需要 TTY，不留任何产物（`~/.local/share/pi-toolkit-secure/` 下无 `acme2`）。

## B. 迁移已有项目

- [ ] `pi-secure unlock acme` → 输入口令。
      预期：挂载成功（挂载点 `~/secure/acme`）；`mountinfo` 含 `fuse.gocryptfs`（`grep gocryptfs /proc/self/mountinfo`）；`<work>/.pi/settings.json` 的 `sessionDir` 指向 `<state>/sessions/default`。
- [ ] `rsync -a ~/ai/acme/ ~/secure/acme/work/`（含 `.git`）。
- [ ] `pi-secure run acme --version`（冒烟；注意**不带** `--` 分隔）。
      预期：pi 版本输出后立即退出（`--version` 不写会话文件），结束后自动卸载（若有 shell 停在库内，会列出占用 pid 并不卸载）。
- [ ] 库内 git 检查：`cd ~/secure/acme/work && git status && git rev-parse --git-common-dir`。
      预期：输出路径位于 `~/secure/acme/work` 内；若是 linked worktree / `.git` 指向库外，加密会话启动时会收到 common-dir 警告（R9）。
- [ ] （可选）旧会话导入：`pi-secure run acme --fork /abs/旧会话.jsonl`（**绝对路径**）。
      预期：会话复制进 `<state>/sessions/default`；相对路径会按库内 cwd 解析而找不到。
- [ ] 迁移收尾：确认新路径一切正常后删除原目录与旧备份，更新 IDE / 脚本绝对路径（SSD 上删除≠擦除，见 R17）。

## C. run 日常

- [ ] `pi-secure run acme`：提示口令 → pi 启动，pi 的 cwd 为 `~/secure/acme/work`。
      预期：状态栏出现 `secure`；`/secure status` 显示 `加密会话：secure（经 PI_SECURE_VAULT 判定）`、项目根/私有区路径、`TMPDIR=<state>/tmp`、已关闭列表（feishu-notify、xs、droid、cron；worktree 隔离会被拒绝）。
- [ ] pi 退出后 `pi-secure status acme`。
      预期：`not mounted`（自动卸载成功）。
- [ ] `pi-secure run acme -C sub`（项目子目录）。
      预期：pi 的 cwd 为 `<work>/sub`，正常可用。
- [ ] 对照（R6/§2.3）：保持挂载，直接 `cd ~/secure/acme/work && pi`。
      预期：项目根直接 `pi` 照常落在 vault 内（sessionDir 生效）；而在**子目录**直接 `pi` 会被 LOCKED（见 E 节现象）。用完 `pi-secure lock acme`。

## D. 守护点手测（在 `pi-secure run acme` 的会话内）

- [ ] **D3 写库外**：让模型用 write/edit 写 `/tmp/d3-<canary>.txt`。
      预期：工具被 block，提示目标不在保险库写入区；`/tmp` 下无该文件。（注意 TMPDIR 在库内，shell 的 `>` 重定向属 bash 尽力而为范围，见 R8。）
- [ ] **D3 写入区边界**：write 到 `~/secure/acme/work`（哨兵路径本身）、`~/secure/acme/` 根层任意新文件与 `<dir>/` 根层任意新文件。
      预期：都被 block（只允许严格位于 `<mnt>/work`、`<mnt>/state` 之下的路径）。
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
  grep -rFa "$CANARY" ~/.pi /tmp /var/tmp ~/secure 2>/dev/null
  ```

注：这只是**终态**检查，不能证明运行期间没写过明文。`~/secure` 未挂载时哨兵读不进、`<dir>/cipher` 是密文不会命中。若执行过 F 节（hub）并经 web / 飞书发送过正文或附件，`~/.pi/agent/web-hub/` 下的明文副本命中属**已接受的 R12**——记录命中路径与数量即可，不算 FAIL；同理 R1（crashes.json）、R4（`/debug`）类命中记录为残留证据。

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

## J. 私有模式（`run --private`）真机验收

对应 [plan.md](./plan.md) §2.8 与 [private-plan.md](./private-plan.md) §6.4。自动化已覆盖互斥、崩溃、最坏路径与 NC1–NC12（`tests/secure/launcher-private*.test.ts`、`tests/conformance/secure-private-ns.test.ts`）；本节覆盖**真机手动路径**：真 pi 的 ^C、插件在会话内的 LOCKED 复检、`/secure status` 两行、web-hub 提示与 notify。前提：机器支持非特权 userns（§2.8.6，不满足时 `run --private` 报 69，可跳过本节）；金丝雀串复用准备节的 `CANARY`。

### J0 准备：删旧布局 demo 库重建 + /reload + hub

- [ ] 删除旧布局 demo 库（L0 之前建的；新代码对它的 `unlock`/`run` 拒绝 78，必须重建才能验收）。先确认它是测试库、无要保留的数据（密文无口令恢复不了），且**退出所有 pi 会话**后再改 settings：

  ```sh
  pi-secure status demo      # 预期：demo 行显示 layout legacy、未挂载（locked/not mounted）
  cp ~/.pi/agent/pi-subagent.json ~/.pi/agent/pi-subagent.json.bak-$(date +%s)
  jq 'del(.secure.vaults.demo)' ~/.pi/agent/pi-subagent.json > /tmp/pi-subagent.json \
    && mv /tmp/pi-subagent.json ~/.pi/agent/pi-subagent.json
  rm -rf ~/.local/share/pi-toolkit-secure/demo
  rm -f ~/secure/demo        # 旧入口符号链接（若存在）
  ```

      预期：`pi-secure status` 不再列出 demo。

- [ ] 重建为私有库：`pi-secure init demo --private`（真实 TTY）。
      预期：privatePreflight 通过 → 提示两次新口令 → master key 打印一次 → stderr 出现边界长句（`--private：明文挂载只存在于…`）→ 再提示一次口令（首次挂载）→ 目录创建、sessionDir 写入、卸载都在私有 ns 内完成（不启动 pi）→ 结束后 `pi-secure status demo` 库行为逐字 `demo: locked  layout ok  mnt /home/<自己>/secure/demo`（下一行 `  dir /home/<自己>/.local/share/pi-toolkit-secure/demo`；无私有实例记录 ⇒ 不渲染任何私有块），`grep -n demo ~/.pi/agent/pi-subagent.json` 条目含 `"private": true`。
- [ ] `/reload`：若验收用的 pi 会话在旧代码（N3 之前）下启动，在普通终端的 pi 里执行 `/reload`。
      预期：重新激活后 ns 判定与 web-hub 闸门代码生效，`/secure status` 正常输出。
- [ ] hub 侧改动需重启 hub 进程：普通终端执行 `/webhub restart`（未启用 webHub 则跳过）。
      预期：新 hub 认 `agent.nospawn.v1`；`/webhub status` 正常。

### J1 `run --private` 与外部视角

- [ ] 终端 A：`pi-secure run demo --private`。
      预期：stderr 先出现边界长句 → 提示口令 → pi 启动（cwd = `~/secure/demo/work`），状态栏 `secure`；`/secure status` 追加两行：「私有命名空间：是（demo）」与「边界：防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）」。
- [ ] 会话内写入金丝雀：让模型 write `~/secure/demo/work/canary.txt`（内容含 `CANARY`）。
- [ ] 终端 B（普通终端）外部视角：
      预期：`ls -la ~/secure/demo` 只见 `work`、`state` 两个 0 字节 0400 哨兵文件；`cd ~/secure/demo/work` 报 ENOTDIR；`grep gocryptfs /proc/self/mountinfo` 无该库条目；`grep -rFa "$CANARY" ~/secure` 零命中；`pi-secure status demo` 显示 `demo: private  layout ok …`，含 `private: session · pi <pid> · supervisor <pid> · gocryptfs <pid> · ns mnt:[…] · since … · id XXXX…`、`lease: held`、`outside view: not mounted · sentinels ok`、`ns members: N` 与 `boundary:` 短句。
- [ ] **已知残留（KNOWN，照实记录不算 FAIL；R20/R21）**：终端 B 执行 `cat /proc/<pi pid>/root/home/<自己>/secure/demo/work/canary.txt`（pid 取自 status 的 `private:` 行）——读到明文；`nsenter -t <supervisor pid> -U -m --preserve-credentials cat <同路径>` 同样可读（NC9 结论）。
- [ ] 互斥：demo 经 J0 重建为私有登记库，终端 B `pi-secure unlock demo`（不带 `--global`）⇒ 在互斥检查**之前**就 exit 64，文案逐字：「demo 配置为 --private（secure.vaults.demo.private=true）：默认不做全局解锁——全局挂载对所有同用户进程可见。用 pi-secure run demo（私有命名空间）；确需全局解锁：pi-secure unlock demo --global（不绕过与私有实例的互斥）」；要验证互斥改用 `pi-secure unlock demo --global` ⇒ exit 76 且**不提示口令**（带 pi pid 的会话运行中文案）；再开 `pi-secure run demo --private` ⇒ 同样 76。若另有一个普通库 B 处于 unlock 状态，`run demo --private` ⇒ 76「保险库 B 正全局挂载…」（Q10）。

### J2 lock / --lazy / --kill / Ctrl-C

- [ ] 终端 B `pi-secure lock demo`（会话仍在运行）。
      预期：exit 76「会话仍在运行（pi pid N）：退出 pi 后自动收尾；--lazy 摘除该命名空间里的挂载路径；--kill 结束会话并收尾」，会话不受影响。
- [ ] `--lazy` 控制组（N4 留给真机：插件会话内 LOCKED 复检）：会话内先起控制项 `!cd ~/secure/demo/work && sleep 600 &`；终端 B `pi-secure lock demo --lazy`。
      预期：exit 0 + 「已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）。要真正结束访问请用 --kill」；控制进程（cwd 在挂载内）**仍能读到明文**（R29 照实记录）；新的路径访问失败；回到会话发一条消息或调一次工具 ⇒ 状态栏切 `secure:locked`、输入被拦（这是插件复检的完整真机链路，自动化只断言了判据）；`/quit` 仍可退出。
- [ ] 重开一次会话后 `pi-secure lock demo --kill`。
      预期：会话结束，`run` 进程以 143 退出；`pi-secure status demo` 立即回到库行 `demo: locked  layout ok  mnt /home/<自己>/secure/demo`（记录已删 ⇒ 无私有块）；`ls ~/.local/share/pi-toolkit-secure/demo/private.json` ⇒ 不存在；租约空闲。
- [ ] Ctrl-C（N4 的 NC2b 用假 pi，此处验真 pi）：重开 `run demo --private`，pi 运行中在 TTY 按 ^C。
      预期：pi 自行处理 SIGINT（中断/退出行为属 pi 自身）；gocryptfs 已 setsid 不受影响；P0/P1 不因 ^C 崩溃；若 pi 退出 ⇒ 按正常路径收尾（status 干净）。
- [ ] 正常 `/quit`：`echo $?` = pi 的退出码（正常 0，透传）；`pi-secure status demo` 立即 not mounted（无 75、无「收尾未完成」提示）；`private.json` 已删除、租约空闲。

### J3 崩溃收尾（真机手动）

- [ ] 遗留后台成员：会话内 `!sleep 1000 &` 后 `/quit`。
      预期：收尾 stderr 列出并终止该进程；status ⇒ not mounted；记录与租约释放。
- [ ] 杀监督者：从 status 的 `private:` 行取 P0/P1 pid，终端 B `kill -9 <P0> <P1>`。
      预期：P0 是 pty 控制进程，前台进程组（含 pi）随之收到 SIGHUP，默认处置的 pi 会退出；gocryptfs 已 setsid 存活并持租约 ⇒ `pi-secure status demo` 显示 `private:orphan`；`pi-secure lock demo` 外部收尾后 0，随后可正常重挂。
- [ ] 无法证明归属的成员（R36）：重开会话，会话内 `!setsid sleep 1000 &` 后仅 `kill -9 <P1>`（P0、pi 随后按上条退出）。
      预期：sleep 存活但 ppid 链断 ⇒ status 为 `private:ns-in-use`（或 orphan-ns，列出无法证明的 pid）；`run demo --private` 与 `unlock demo --global` 都 76；人工 `kill <sleep pid>` 后 `pi-secure lock demo` 清理后 0。（不带 `--global` 的 `unlock demo` 在互斥检查前就以 64 拒绝，见 J1。）

### J4 web-hub（N3）

- [ ] hub 未运行（普通终端先 `/webhub stop`）时 `pi-secure run demo --private`：启动器 stderr 提示一行（「web-hub 当前未运行：私有命名空间内的会话不会自动拉起它…在普通终端的 pi 里执行 /webhub start」）；会话内触发一次 hub 拉起（如 `/webhub status`）。
      预期：一次性 notify「本会话运行在私有挂载命名空间内，不会自动拉起 web-hub（它会被困在命名空间里并持有明文视图）。需要网页时，在普通终端的 pi 里执行 /webhub start。」；hub 未被拉起；二次尝试不再 notify。
- [ ] 会话内 `/webhub restart`：被拒（在任何停机动作之前）——「本会话运行在私有挂载命名空间内，已拒绝 /webhub restart（新 hub 会被困在命名空间里并持有明文视图）。需要重启 hub 时，请在普通终端的 pi 里执行 /webhub restart。」；`/webhub open` 只打印 URL 不开浏览器；`/webhub stop` 放行。
- [ ] hub 已在 ns 外运行（普通终端 `/webhub start`）：网页能实时看到 ns 内会话（D1/R12 已接受）。`agent.nospawn.v1` 使 hub 跳过该 agent 的版本替换观察——`/webhub status` 不展示单个 agent 的 caps，真机无可靠观察法：该行为由 `tests/web-hub/hub/nospawn-cap.test.ts` 钉住，真机不单独验证（R25 只在「新 agent + 旧 hub」组合存在，J0 的 `/webhub restart` 已消除）。
- [ ] 嵌套 pi 不拉起 hub：会话内 `!pi --version`（env 已被剥离的情形同样）。
      预期：正常输出版本；无新 hub 进程。

### J5 兼容性与前置（private-plan §6.4 尾部）

- [ ] 会话内：git commit / push（ssh agent 转发可用性照实记录）、`node -v`、`ls -l /etc`（部分属主显示 `nobody nogroup` —— 嵌套 userns 的已知映射现象）、`sudo -v`（预期失败）。
- [ ] `pi-secure run demo --no-private`（私有登记库）：正常运行 + 一行可见性提醒（全局挂载对所有同用户进程可见）。
- [ ] `pi-secure unlock demo`（私有库，不带 `--global`）⇒ exit 64 + 提示改用 `run`/`--global`；`unlock demo --global` 仍走互斥闸门（会话运行中 ⇒ 76）；`--lazy --kill` 同用 ⇒ 2。
- [ ] （AppArmor 限制的机器才可验）`run demo --private` ⇒ exit 69 并说明；不带 `--private` 照常可用。

### J6 N4 报告「留给真机」项的对照

| N4 残留项（N4-report §9）                         | 本节落点                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| 真 pi 的 ^C（NC2b 用假 pi）                       | J2                                                              |
| 插件在会话内的 LOCKED 复检（--lazy 后）           | J2                                                              |
| `/secure status` ns 两行 / 普通会话库行后缀       | J1、J4                                                          |
| web-hub 启动器提示 + 一次性 notify + restart 拒绝 | J4                                                              |
| 最坏路径（P1 75 → P0 外部收尾）只能靠测试缝复现   | 自动化覆盖（`launcher-private.test.ts` WORST PATH），真机不重复 |

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
| J   |                          |                             |      |
