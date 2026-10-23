# 私有挂载命名空间可行性实测（private-ns-probe）

- 日期：2026-10-23 · 探针：`scripts/dev/secure-ns-probe.sh`（mktemp 测试保险库 + 假口令，trap 保证失败也清理；不改 `src/`）
- 环境：Ubuntu 22.04.5 · kernel 5.15.0-198-generic · util-linux 2.37.2（unshare 有 `--map-user/--map-group`，无 `--map-current-user`）· gocryptfs 1.8.0（go-fuse 2.0.3）· fusermount3 · `/dev/fuse` 0666 · `kernel.unprivileged_userns_clone=1` · `yama.ptrace_scope=1` · `/proc` 无 hidepid · 无 sudo
- 复现：`bash scripts/dev/secure-ns-probe.sh | tee ns-probe.log`（约 4 分钟，含 `pi -p` 真机项）；`--fast` 跳过 pi 真机项。本文所有「输出」均为 2026-10-23 实测原文摘录。

## TL;DR 总判定

1. **技术上可行**：外层 `unshare --user --map-root-user --mount --propagation private` 内 gocryptfs **直接 FUSE 挂载成功（不经 setuid fusermount，mountinfo `user_id=0`）**；内层 `unshare --user --map-user=<uid> --map-group=<gid>` 回真实 uid 跑负载。git/ssh/node/tmux socket/子进程/**真机 pi（`--version` 与 `pi -p --no-session` 均成功）**全部正常，属主显示真实 uid，数据完整性经普通模式重挂逐场景核验全部通过。
2. **外部路径视角目标达成**：全部 6 个生命周期场景中，外部同用户进程看 `<dir>/mnt` 永远只有 0 字节 0400 哨兵（`regular empty file 0字节 400 1001:1001`）；挂载不出现在外部 mountinfo；无传播泄漏。
3. **但对「同 uid 定向攻击者」是软边界**（§4，两条内核级绕过）：`/proc/<pid>/root`、`/proc/<pid>/cwd` 对同 uid **完全无门禁**（连 `PR_SET_DUMPABLE=0` 的进程也拦不住 root/cwd 链接；fd 链接才会被拦）；同 uid 进程可 `setns` 依次进入 userns+mntns（userns owner 规则，strace + PoC 双重实证）。⇒ 定性：**防误读 / 防扫描 / 防其他程序无意识读取（纵深防御）；不防懂 /proc 的同 uid 恶意进程**。对非同 uid、非 root 是硬边界。
4. 与现状对比：现状明文全局可读（无需任何技巧）；ns 方案把门槛从「任意路径直接读」提升到「需主动走 `/proc/<pid>/root` 或 setns」。**值得做，但必须如实披露边界**。

## 1. 逐项实测

### 1.1 挂载路径（任务 1）

**嵌套 uid 映射**（P1）：

```
outer id: 0/0  uid_map:  0 1001 1
inner id: uid=1001(bluecake) gid=1001(bluecake) groups=1001(bluecake),65534(nogroup)
inner uid_map: 1001 0 1   gid_map: 1001 0 1
inner CapEff: 0000000000000000        ← 负载层零能力位
```

外层 `--map-root-user` 写 `0→1001`；内层 `--map-user=1001`（在 ns-root 环境里）写 `1001←0`，两者在内核侧都收敛到 kuid 1001 ⇒ 内层显示真实 uid/gid，**负载无任何 capability**。注意：单段 `unshare --user --map-user=1001 --mount` 不可行——setresuid 后无 caps，挂不了 FUSE；**两段式是必要结构**。

**userns 内直接挂载**（P3/P6）：gocryptfs 以 ns-root 走内核直挂路径（`/dev/fuse` 0666 可开，FUSE 有 `FS_USERNS_MOUNT`）：

```
MOUNT-READY 2612 2412 0:69 / /tmp/.../vault/mnt rw,nosuid,nodev,relatime - fuse.gocryptfs /tmp/.../vault/cipher rw,user_id=0,group_id=0,max_read=131072
```

`user_id=0` 证明挂在 ns-root 视角、未经 fusermount（对照：普通模式挂载 `user_id=1001` 且走 fusermount3）。日志无 fusermount 调用痕迹。

**传播**：util-linux 2.37 `unshare --mount` 默认即 private（独立 tmpfs 子实验：外部看不到）；主链显式 `--propagation private`，mountinfo 无 `shared:` 标记。外部 `stat <dir>/mnt/work` 全程哨兵。

**ns-root 直跑负载对照**（P4b，任务 1 后半）：

```
ns-root id: uid=0(root) ... whoami: root
ns-root 属主视角: f.txt=0:0 664（ns 内用户文件全显示为 0）
git status rc=0  rev-parse=10689f3 ；ssh-keygen -y rc=0 ；/etc/passwd 不可写（无真 root，kuid 仍是 1001）
ns-root 在 /tmp 新建的文件，外部（真实内核视角）属主: 1001:1001
```

功能上 git（属主检查 0==0 通过）、ssh、node 都能跑，`/etc/passwd` 不可写证明没有真 root。但副作用真实存在：一切 `euid==0` 行为分叉（pip/npm 的 root 检查、工具选 root 家目录路径、`ls -l` 全 0:0 误导排障），且负载持有 ns 内 `CAP_SYS_ADMIN`（可自行 umount/mount，破坏外部 lock 语义）。**结论：ns-root 只用来挂载，负载必须走内层映射回真实 uid。**

### 1.2 外部可见性（任务 2，ptrace_scope=1，sibling=同 uid 非祖先进程）

| #   | 通道（挂载活跃期）                                                          | 结果                                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 直接 `cat <dir>/mnt/work/repo/secret.txt`                                   | `Not a directory`（哨兵挡住）✓                                                                                                                                    |
| ②   | `cat /proc/<gocryptfs>/root/.../secret.txt`                                 | **读到明文（rc=0）**                                                                                                                                              |
| ③   | `cat /proc/<ns 内 sleeper>/root/...`                                        | **读到明文**                                                                                                                                                      |
| ④   | `cat /proc/<sleeper>/cwd/secret.txt`                                        | **读到明文**；`readlink cwd` 泄露路径                                                                                                                             |
| ⑤   | `readlink /proc/<sleeper>/cwd`                                              | 路径字符串泄露（次要）                                                                                                                                            |
| ⑥   | `cat /proc/<dumpable=0 进程>/fd/3`                                          | `Permission denied` ✓（fd 链接走 ptrace READ 检查，dumpable=0 生效）                                                                                              |
| ⑦   | `readlink /proc/<dumpable=0>/fd/3`                                          | 拒绝 ✓                                                                                                                                                            |
| ⑧   | `dd if=/proc/<gocryptfs>/mem`（offset 0）                                   | open 成功但读 `Input/output error`，**未取得内容**；基线（初始 ns 目标）open 即 `Permission denied`——跨 userns 的 ATTACH 门禁表现不一致，如实记录，不视为可靠防线 |
| ⑨   | `cat /proc/<dumpable=0>/root/...`                                           | **读到明文**（root 链接根本不做 ptrace/dumpable 检查）                                                                                                            |
| ⑩   | `nsenter --target <gocryptfs> --user --mount true`                          | nsenter 退出 1，**但这是假象**，见⑬                                                                                                                               |
| ⑪   | `grep /proc/<gocryptfs>/mountinfo`                                          | 可读（泄露挂载存在与 cipher 路径；`maps`、dumpable=1 的 fd 列举同样可读）                                                                                         |
| ⑫   | **setns PoC**（python3 直调 `syscall(308,...)` join userns→mntns 再读文件） | **join 成功，明文可见: True 内容: probe-secret-…**（完整绕过链）                                                                                                  |
| ⑬   | strace nsenter                                                              | `setns(3, CLONE_NEWUSER) = 0`；`setns(4, CLONE_NEWNS) = 0`——两个 setns 都成功，nsenter 只是收尾 `setgroups` EPERM 才退出 1。**不要用 nsenter 的失败代表攻击面**   |

**基线对照**（目标=初始 ns 中无任何命名空间的普通 sleep）：`/proc/<pid>/root` 同样无门禁（sibling 读出 `/etc/hostname`）、`/mem` open 即 EPERM、`maps`/fd 列举可读 ⇒ root/cwd 链接的开放**与命名空间无关**，是本机内核（5.15 + ptrace_scope=1 + 无 hidepid）对同 uid 的普遍行为；私有 ns 没有打开新通道，只是没有关掉既有通道。

**祖先视角**（= 启动 pi-secure 的 shell/agent 会话链）：root 链接 OPEN-OK 直接读到明文——但祖先本来就是受信方（口令由用户在此输入）。yama 的「祖先放行/非祖先拦截」只对 ATTACH 类（`/mem`、真 ptrace）生效，READ 类与 root/cwd 链接不受其约束（实测确认）。

**nsenter 绕过的内核根因**（strace 实证）：目标 userns 的 owner（创建者 kuid 1001）== 调用者 euid（kuid 1001）且目标 ns 的父就是调用者所在 ns ⇒ 内核 `cap_capable()` 的 owner 规则视调用者为拥有目标 ns 全部能力 ⇒ `setns(userns)`、随后 `setns(mntns)` 均成功。这是 user namespace 的属主模型，**无内核开关可关**。

### 1.3 负载兼容（任务 3，全部在内层真实 uid 下）

- **git**：init/add/commit/rev-parse/status 全部 rc=0；`git status --porcelain` rc=0 ⇒ **无 dubious ownership 问题**（属主 1001 == euid 1001）；`git config --global --list` 正常。
- **node**：vault 内读写正常；`os.tmpdir()=/tmp`、`os.homedir()=/home/bluecake` 正常。
- **ssh**：`ssh-keygen` 生成（属主 1001:1001 600）与 `ssh-keygen -y` 私钥属主检查通过；`ssh -G` config 解析+属主检查通过；本机无 SSH_AUTH_SOCK（跳过）；**tmux socket 目录 `/tmp/tmux-1001` 可达**（无活动会话，`list-sessions` rc=1 属正常）——unix socket 不受 mount ns 影响。
- **子进程/后台作业**：子进程 `/proc/*/ns/mnt` 与父一致（fork 自动同 ns）⇒ 子 agent、后台 bash 无需任何处理。
- **真机 pi**：`pi --version` rc=0（1.3.0）；`pi -p --no-session "Reply with exactly: OK"` **rc=0，输出 "OK"**——完整模型调用在嵌套 ns 内成功。
- 语义细节：内层 supplementary groups 显示为 `1001,65534(nogroup)`（kgid 成员实际保留，仅 ns 显示折叠为 overflow gid；内核权限检查用 kgid，不影响访问）。

### 1.4 生命周期（任务 4）

| 场景                              | 结果                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常收尾                          | 负载退出 → 清理 cwd 持有者 → `umount` rc=0 → `wait gocryptfs` 退出 0；哨兵恢复；重挂核验完整性 ✓                                               |
| 挂载 busy                         | 有进程 cwd 在挂载内时 `umount` 报 `target is busy`(32)；**先杀持有者再 umount，或 `umount -l` 兜底**（两法均实测）                             |
| 外部 lock                         | 跨 ns `kill -TERM <gocryptfs pid>`（同 uid 信号不受 ns 限制）⇒ gocryptfs **干净卸载**退出（exit 15），监督者 `final.state=unmounted`，完整性 ✓ |
| pi-secure 被 SIGKILL              | gocryptfs 成孤儿（ppid=1）继续持 ns；外部哨兵视角不变；泄漏通道照旧（§4）；外部 TERM 即可收尾，完整性 ✓                                        |
| gocryptfs 被 SIGKILL + 监督者退出 | ns 引用归零**自动销毁**，重挂核验完整性 ✓（崩溃自愈到哨兵态）                                                                                  |
| 守护被困 ns                       | 监督者退出后 `setsid sleep` 与 gocryptfs 同 ns 存活并持有明文视图（`/proc/<daemon>/ns/mnt` 与 gocryptfs 相同），直到被外部逐 pid 清理          |

注意：私有挂载对外部 `fusermount3 -u <mnt>` 不可见（外部无该 mtab 条目）——**外部收尾只能走信号 + pidfile，不能走 fusermount**。

### 1.5 与现有 toolkit 的冲突点（任务 5）

- **web-hub**：ns 内 pi 拉起的任何守护进程（hub 即是）会继承 mnt ns（实测 `setsid` 守护与 gocryptfs 同 ns id），后果有二：① hub 永久持有明文视图且阻止 ns 自动销毁（pi-secure 退出后明文仍活在 ns 里）；② hub 的 TCP/socket 本身不受 ns 影响（无 netns），但其全部子进程（spawn 的 pi 等）都困在 ns 内。对策方向（优先级从高到低）：
  1. helper 进 ns 前检测 `webHub.enabled` 且 hub 未运行 ⇒ **在 ns 外预拉起 hub**（复用现有进程级连接；hub 与会话不同 ns 不影响其代理职责）；
  2. ns 内导出 `PI_SECURE_NS=1`，`src/web-hub/agent/launcher.ts` 检测到即拒绝 spawn 并提示「先在 ns 外 /webhub start」；
  3. 文档披露。**nsenter 逃逸（从 ns 内出去）不可行也不必要**——正确解法是别把 hub 放进 ns。
- **子 agent / 后台 bash**：同 ns 正常（§1.3），无冲突。
- **`pi-secure status`**：外部看不到私有挂载的 mountinfo ⇒ 现行 `mountState` 探测失效。配方（P11 实测）：pidfile（明文区 0600，记录 gocryptfs pid、监督者 pid、`/proc/<pid>/ns/mnt` id、启动时间）→ `kill -0` 存活 + `readlink /proc/<pid>/ns/mnt` 与记录值比对 ⇒ running；进程消失 ⇒ not-running。辅助 oracle：外部能读同 uid 进程的 `/proc/<pid>/mountinfo`（可 grep `fuse.gocryptfs` 发现"某个私有挂载在跑"，但定位不到具体保险库）。哨兵校验保持现有逻辑作反向确认。注意 **ns id 会被内核回收复用**（实测），判活以 pid 存活为主、ns id 为辅。
- 其他：同一 cipher 多实例并发挂载（私有 ns ×N + 普通模式）实测共存且完整性无损；P0 既有结论（`-fg` 前台、TERM 后干净退出、KILL 后 ENOTCONN 可 `fusermount3 -uz` 清理）全部沿用。

## 2. 可行性总判定

**有条件可行，推荐实施**：

- 「明文挂载只对 pi 进程树可见（**路径视角**）」—— 100% 达成（哨兵全程完好、外部 mountinfo 不可见、无传播泄漏）；
- 负载兼容 —— 全部通过（含真机 pi 完整调用）；
- 生命周期/lock/status —— 全链路可落地（pidfile + 信号 + 哨兵复检）；
- 「对同 uid 恶意进程不可见」—— **不可达成**（内核设计：root/cwd 链接无门禁 + setns owner 规则），但相比现状（明文全局路径直读）是实打实的边界收紧：误读、`find/grep` 扫描、备份工具、其他 agent 的无意识访问全部被挡，攻击者必须主动构造 `/proc/<pid>/root` 或 setns 攻击链。

## 3. 推荐实现形态（`pi-secure run --private`）

```sh
exec unshare --user --map-root-user --mount --propagation private -- bash -ec '
  gocryptfs -fg -nonempty [--passfile …/--extpass …|TTY] -- <dir>/cipher <dir>/mnt 2>> <dir>/ns.log &
  GP=$!
  # pidfile：<dir>/ns-<name>.pid（0600，明文区）＝ gocryptfs pid + 监督者 pid + ns id + 时间戳
  # 轮询 /proc/self/mountinfo 就绪（≤15s），失败即 TERM 退出
  trap "kill -TERM \$GP 2>/dev/null; wait \$GP" EXIT INT TERM
  exec unshare --user --map-user=$(id -u) --map-group=$(id -g) -- pi …原参数…
'
# 监督者在 pi 退出后：杀 ns 内遗留持有者（同一进程组）→ umount（busy 则 -l）→ wait gocryptfs（期望 0/15）
```

- **uid 映射**：两段式必须（§1.1）；util-linux ≥2.34 的 `--map-user/--map-group` 即够，`--map-current-user` 非必需。
- **口令**：保持现状 TTY 直读（探针用 `-passfile` 仅为自动化）；`-fg` 必带（生命周期可控 + stderr 日志）。
- **lock**（外部进程）：读 pidfile → `kill -TERM <gocryptfs>` → 轮询进程消失/哨兵 → `-9` 兜底；若有被困守护，按 pidfile 逐 pid 清理，ns 随最后进程退出自动销毁。
- **status**：pidfile + `kill -0` + ns id 比对；哨兵校验反向确认。
- **web-hub**：§1.5 对策（预拉起或拒绝）。

## 4. 安全残留（如实披露）

1. **`/proc/<pid>/root`、`/proc/<pid>/cwd` 无门禁**（实证 ②③④⑨，含 dumpable=0 目标）：同 uid 任意进程可读明文。缓解（均超出本工具能力，需管理员）：`/proc` 以 `hidepid=1/2` 重挂，或 `yama.ptrace_scope=2/3`（同时收紧 /mem、fd 等 READ/ATTACH 检查）。单进程 `PR_SET_DUMPABLE=0` 只能挡 fd/mem 类（⑥⑦），且 exec 会重置、无法覆盖整棵负载树与 gocryptfs 守护。
2. **setns owner 规则**（⑫⑬）：同 uid 可进入 userns+mntns。无内核开关。
3. **nsenter 的失败是假象**：测试安全边界请用 setns 直调或 strace 核对，不要拿 nsenter 退出码当结论。
4. **信息面泄露**：`/proc/<pid>/{maps,mountinfo}`、dumpable=1 进程的 fd 列举对同 uid 可读——暴露「存在一个 gocryptfs 挂载」与 cipher 路径（cipher 本身是密文，路径泄露无实质危害）。
5. **孤儿窗口**：pi-secure 被 SIGKILL 后 gocryptfs 存活持 ns（明文仍只暴露于上述 /proc 通道，路径不可见）；收尾依赖 pidfile。极端情况下 pidfile 与进程同时丢失 ⇒ ns 里挂着明文直到机器重启或进程被人工发现（`/sys/fs/fuse/connections` 可作排查线索）。
6. **既有残留不变**：swap/coredump（plan R2/R3）、终端/tmux 回显（R16）、gocryptfs 进程内存中的明文与密钥（同 uid `/mem` 跨 userns 的 open 表现实测不一致但未取得内容，不视为防线）。

## 5. 工作量估计

| 项                                                                                          | 估时       |
| ------------------------------------------------------------------------------------------- | ---------- |
| launcher（helper.mjs）：`--private`、两段 unshare 命令链、pidfile、收尾/孤儿清理、busy 处理 | 1~1.5d     |
| lock/status 改造（pidfile 判定 + TERM 链路 + 哨兵复检）                                     | 0.5d       |
| 插件侧：`PI_SECURE_NS` 标记 + web-hub 拒绝 ns 内拉起（launcher.ts 一处判断 + 文案）         | 0.5d       |
| 文档（plan.md 增补私有模式与残留清单）+ 探针维护                                            | 0.5d       |
| 测试：launcher 单测 + conformance 增节                                                      | 0.5~1d     |
| **合计**                                                                                    | **3~4.5d** |

## 附：探针脚本

`scripts/dev/secure-ns-probe.sh`，11 个阶段（P0 环境 / P1 映射 / P2 init / P3+P4+P6 挂载+负载+正常收尾 / P4b ns-root 对照 / P5 可见性基线+全通道+setns PoC+strace / P7 外部 lock / P8 孤儿 / P9 自动销毁 / P10 守护被困 / P11 status 配方）。只用 `mktemp -d` 测试保险库与假口令；EXIT/INT/TERM trap 保证失败也清理（pid 均有 `<2` 守卫，防 `kill 0` 自杀）；不触碰真实保险库与 `~/.pi` 配置（`pi -p --no-session` 为用户点名的真机项，`--no-session` 不落会话文件）。
