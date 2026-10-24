# 加密会话（gocryptfs 保险库）实施方案 — plan r4（务实版）

> 状态：r4（2026-10-23）。用户已把范围定为**务实版**，Q1/Q2 已拍板。r4 回应 r3 复审（0 Blocker / 2 Major / 2 Minor，处置见 §R3）；r2 复审的处置见 §R2。r1、r2 的严格路线（旁车租约、
> 双锁、hub 启动器路由、crash 清洗等）全部撤下，被否决的方案见 §8。前置调研：`explore.md`。适用 pi 1.3.0（peer `>=1.0.0 <1.4.0`）。
> 本机：Ubuntu 22.04 / 5.15；`/usr/bin/{fusermount3,flock,fuser,strace}` 和 `/dev/fuse` 都在；**gocryptfs 已装（apt 1.8.0，go-fuse 2.0.3；P0 实测见 §1 与 §P0 回填，版本下限放宽为 ≥1.8）**。

---

## 0. 拍板

### 0.1 范围（用户 2026-10-23「务实版」）

toolkit 提供一键**创建、解锁、卸载** gocryptfs 加密目录的命令。项目和它的会话记录都放在里面，挂载后正常使用。插件只做**轻量守护**：

- 会话不在保险库里、或保险库没挂载时锁住会话；
- 按 D2–D4 拦截；
- 关闭 D8 列出的自动外推。

无法堵死的路径写进 §5「已披露残留清单」。**不承诺「绝不写明文」**。目标工作量 3–4 天。

### 0.2 已拍板项（保留）

| #   | 结论                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 加密会话**照常连 web-hub**。会话内容经 hub、web、LAN、飞书机器人以明文可见，挂载期间 preview 可读 vault，这些都已接受（§5 R12）                               |
| D2  | worktree 隔离：**拒绝**（务实版维持原判，不改判；git common-dir 问题见 R9）                                                                                   |
| D3  | 加密会话用 write/edit 写到 vault 外：**拦截**                                                                                                                 |
| D4  | 普通会话读 vault：**拦截**（工具层拦截；bash 只能尽力而为）                                                                                                   |
| D5  | 改 pi-traffic-record 仓库：见到 `PI_SECURE_SESSION=1` 就跳过落盘；toolkit 检测到它未适配时警告                                                                |
| D6  | master key 只显示一次、不落盘（务实版由 gocryptfs `-init` 在终端打印，见 Q1）                                                                                 |
| D7  | 退出时尽力卸载，卸不掉就警告（§2.5，有界、不卡死）                                                                                                            |
| D8  | toolkit **主动外推**的功能在加密会话中关闭：feishu-notify 卡片、cron 新建、fabric 跨会话（xs）、droid。**飞书机器人**（hub 侧）按 D1 照常可见，不在 D8 范围内 |
| D9  | 口令最多 3 次，失败间隔 1s/2s/4s                                                                                                                              |

### 0.3 本轮按务实版直接定下（不再单独提问）

- worktree：维持 D2 拒绝。
- 不推荐全局 `alias pi=pi-secure`（与 `pi install` 等冲突）。管理和启动都走独立命令 `pi-secure …`。
- swap 与 core：**只警告**（`pi-secure status` 和 `unlock` 打印检测结果与处置建议），不拒绝启动。
- web spawn 和 restore：hub **协议**不改，只在两处加环境清洗：拉起 hub 进程时，以及 hub 托管 spawn 子会话时（§2.7）。保险库已挂载时照常可用；卸载后再挂载，旧会话的 restore 或 relaunch 可能失败（R13）。
- pi 原生显式导出（`/debug` `/export` `/share` `/copy`）、绕过 `pi-secure` 直接用 `pi`、crashes.json 等，写入残留清单，不做事后清洗。

### 0.4 已拍板（2026-10-23，原 Q1/Q2）

| #   | 结论                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | master key 由 gocryptfs `-init` 在**终端**打印一次（不经过 pi TUI）。toolkit 不读取、也不记录口令和 master key。启动器随后提示 `clear` 和 `tmux clear-history`，这只是尽力清理，算不上安全擦除（R16）。init 只能在真实 TTY 上进行；探针和 trace 不得使用真实密钥 |
| Q2  | hub 的**磁盘明文副本**作为残留接受（R12）。完整类别见 R12：附件、飞书机器人文件、history 快照、飞书 durable request 正文、待发回复和卡片的 outbox、managed spawn 的 stderr 日志                                                                                  |

### 0.5 加密对目录结构的影响（给用户）

1. **项目要搬进保险库**。项目改放在 `~/secure/<name>/work`。`~/secure/<name>/` 是挂载点目录（0700），`<dir>` 默认是 `~/.local/share/pi-toolkit-secure/<name>`（只放密文与元数据）。
   一个保险库可以放一个或多个项目（`work/` 下的子目录）。
2. **未挂载时进不去**。卸载后 `~/secure/<name>/` 里只剩 `work`、`state` 两个哨兵文件，`cd ~/secure/<name>/work` 和打开都会失败，IDE 里已打开的窗口也会报错。先执行 `pi-secure unlock <name>`，或直接用 `pi-secure run <name>`。
3. **项目内的相对路径不变，绝对路径会变**：
   - `src/a.ts`、`../lib` 这类相对引用都照常工作。
   - 旧绝对路径（例如 `~/ai/acme/...`）全部失效。IDE 工作区、shell 脚本、cron、systemd unit、docker-compose 的 bind mount、`.env` 里的绝对路径都要更新。
   - pi 和 git 看到的路径就是 `~/secure/<name>/work/...`（`$HOME` 不经符号链接时它就是物理路径），会话 header、web-hub 卡片和日志里显示的也是它。
4. **git 仓库要整体放入**（含 `.git`），不能只搬工作区。linked worktree，或 `.git` 指向保险库外的仓库，commit 的对象会写到外面（R9）。远端 push 照常进行，按设计就是明文上传。
5. **其他进程看不到保险库**。没有 `allow_other` 时，只有你本人（同 uid）能访问挂载：root、docker 守护进程、其他用户的服务都看不到。
   容器 bind mount 保险库目录会失败，需要改为在宿主机上运行，或改用其他方案。
6. **性能与文件系统差异**：
   - 大量小文件（如 `node_modules`）读写会明显变慢。
   - 硬链接只能在保险库内部建；指向保险库外的符号链接，其目标仍是明文。
   - 磁盘上的文件名和内容都加密，但文件个数、大小和目录层级可见。
7. **迁移已有项目**：推荐用 `pi-secure convert ~/ai/acme acme`（§2.9.1）。它一次完成建库、拷入（含 `.git`）、逐文件读回校验、会话与 memory 复制、项目 sessionDir，并把原路径换成指向 `~/secure/acme/work` 的符号链接，所以 IDE 和脚本里的旧绝对路径在解锁期间照样能用。原目录**不删除**：它被改名为同级的只读备份 `<原名>.pi-secure-backup-<时间>-<4位>`，`pi-secure status` 会持续列出，确认保险库内容无误后由你自己删除（输出里给出 `chmod -R u+w … && rm -rf …` 命令；SSD/CoW 上删除不等于擦除，R17/R26）。旧会话与旧 memory 同样保留，由你自行删除。跨机器或跨布局（旧布局 demo 库）的迁移用 `export` + `import`（§2.9.2–§2.9.4）。
   convert 拒绝的情形（ACL/xattr、setgid 目录、他组文件、linked worktree、树内挂载等，§2.9.1）可以退回手工方式：
   - ① `pi-secure init acme`；② `pi-secure unlock acme`；③ `rsync -a ~/ai/acme/ ~/secure/acme/work/`（含 `.git`；挂载后 work 是项目根）。
   - ④ `pi-secure run acme --version`（不带 `--` 分隔；`--` 之后的内容按 pi parseArgs 会被当成消息）：每次 `unlock`/`run` 都会幂等补写 `.pi/settings.json` 的 `sessionDir`；项目自带的 `.pi/settings.json` 只合并这一个键，键值不同时会提示。
   - ⑤ 在保险库内执行 `git status` 和 `git rev-parse --git-common-dir`，确认位于 `~/secure/acme/work` 内。
   - ⑥ 旧会话（`~/.pi/agent/sessions/--home-…-ai-acme--/`）按需用 `pi-secure run acme --fork <旧会话文件>` 导入，然后删掉旧目录。
   - ⑦ 项目 memory 按 cwd 存放，新路径会得到一份空 memory；需要的话把 `~/.pi/agent/memory/<旧 slug>/` 复制到 `<state>/memory/<新 slug>/`。
   - ⑧ 删除原目录和旧备份（SSD 或 CoW 文件系统上，删除不等于擦除，R17）。
   - ⑨ 更新 IDE 和脚本里的绝对路径。

---

## 1. 关键事实（证据）

| 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 证据                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| sessionDir 的优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > 设置；项目设置只读 `<cwd>/.pi/settings.json`（不向上查找），且在信任判定**之前**读取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `PI/dist/main.js:551-555`；`settings-manager.js:124,523-526`；`docs/configuration.md:3` |
| 扩展加载**之前**就可能写会话：`--fork` 复制整份会话；打开已有空文件或旧版文件会重写；`--name` 会追加                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `main.js:289-302,570-576`；`session-manager.js:671-679,722-724,1374-1413`               |
| pi CLI 解析器可以直接复用：`dist/cli/args.js` 导出 `parseArgs`（`--fork`/`--session`/`--session-dir` 都消费下一个参数，`@file` 进 `fileArgs`，`--no-extensions` 等）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `PI/dist/cli/args.js:15,22-33,87-100,161,239`                                           |
| `os.tmpdir()` 每次调用都读 `TMPDIR`；pi 的截断输出、外部编辑器、剪贴板临时文件都走它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `PI/dist/utils/output-files.js:15-17`                                                   |
| memory 根目录可以用环境变量 `ARMORY_MEMORY_ROOT` 改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/memory/paths.ts:25-28`                                                             |
| `preGuardSettings` 在 activate 一开始就读取；主会话的设置也在 activate 时冻结                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `src/index.ts:178`、`:232-243`、`:283-288`                                              |
| 设置有两个入口，`loadSettingsFromFile` 和 `readSettingsNoMigrate`，最终都经过 `loadSettings(source)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `src/config/settings.ts:1659,3367,3461`                                                 |
| 子会话总是落在默认目录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/runtime/session-driver.ts:858` `SessionManager.create(cwd)`                        |
| bash job 的写入根、恢复扫描、子会话三处都读 `settings.bashJobs.dir`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/stack.ts:783-793,3324`；`src/bash/child.ts:262`                                    |
| workflow journal 和 consult fork 的根目录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `src/stack.ts:3426`；`src/consult/fork-store.ts:78-79` 及 `src/stack.ts:3056-3076`      |
| pi 原生命令 `/debug` 写 `~/.pi/agent/pi-debug.log`（含全部消息）；`/export` 不带参数时写 `process.cwd()`；这些命令扩展都拦不到                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `interactive-mode.js:2542-2686,5445-5462,5830-5852`；`session-export.js:25-30`          |
| `session_before_switch` 可以取消，但 `/import` 只暴露目标路径，`fork` 和 `tree` 各有自己的事件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `agent-session-runtime.js:78-99,128-176,258-294`                                        |
| 管道型 core_pattern 不受 `RLIMIT_CORE` 限制；本机 core_pattern 是 `\|/usr/share/apport/apport …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `core(5)`（复审核实）；`/proc/sys/kernel/core_pattern`                                  |
| fusermount3 要求挂载点可写；gocryptfs 遇到非空目录时 exit 10（`-nonempty` 可放行），口令错时 exit 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `strings /usr/bin/fusermount3`；gocryptfs `exitcodes.go`、manpage                       |
| **P0 实测（gocryptfs 1.8.0，2026-10-23，`scripts/dev/secure-probe.sh` + `tests/conformance/secure-gocryptfs.test.ts`）**：方案所需行为 1.8.0 **全部满足**，版本下限放宽到 ≥1.8（apt 版即可，无需官方二进制）。要点：`-init` 经 TTY 读口令两次（`Password:`/`Repeat:`）并打印 64 hex master key（8 组×8 hex，折两行、带 ANSI dim）；**`-init -q` 不打印 master key**（生产 init 禁用 `-q`）；挂载经 TTY 读口令（`-q` 也照样提示）；`-nonempty` 可挂到含哨兵文件的目录，缺省时 exit 10；口令错 exit 12（passfile 与 TTY 一致）；已有 cipherdir 再 init exit 7；挂载点不可写 exit 19；mountinfo 为 `fuse.gocryptfs`、source=cipherdir 绝对路径；默认守护化（实为 `gocryptfs -fg -notifypid=…` 重新执行的子进程）；`-fg` 前台运行至卸载后 exit 0；`-extpass`/`-passfile` 可用；`flock -o` 下 unlock 返回后锁立即可得，**不加 `-o` 则守护进程继承并长期占锁**；cwd 在挂载内 `fusermount3 -u` 报 busy；挂载根 0500 时卸载照常成功；守护被 KILL 后为 ENOTCONN，`fusermount3 -u` 可清理 | `docs/dev/data-encryption/P0-report.md`；探针与 conformance C1–C5                       |
| npm `files` 已包含 `src`，放在 `src/` 下的脚本会随 git 安装和 npm 包一起分发                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `package.json` `files`                                                                  |

---

## 2. 设计

### 2.1 目录布局（r4 哨兵法；布局已按 private-plan §L.1 迁移，L0 落地 2026-10-24）

```
<dir>  默认 ~/.local/share/pi-toolkit-secure/<name>/   (0700)   明文区，只放元数据
 ├─ cipher/                gocryptfs.conf 和密文（0700）
 ├─ mount.lock             串行化 mount/umount 状态变迁（flock -w，有超时）
 └─ mount.lease            挂载租约（L0 建空文件 0600；N1 起每次挂载都持有）
<mnt>  默认 ~/secure/<name>/   (0700)   挂载点（init --path 可指定）
 ├─ work   ← 未挂载时是 0 字节、0400 的普通文件（哨兵）；挂载后 = 项目根
 └─ state  ← 同上；挂载后 = toolkit 私有区（sessions/default、tmp、bash-jobs、workflows、consult、memory）
```

- **没有入口符号链接**（L0 取消）：挂载点就是 `~/secure/<name>` 本身，pi 的物理 cwd 就是 `~/secure/<name>/work`。
- 未挂载时，所有指向 `<mnt>/work/…` 或 `<mnt>/state/…` 的写入（包括 pi 的 `mkdirSync(sessionDir)`、`mkdir -p`、write 工具）都会因 ENOTDIR 失败，不依赖权限位，也不存在需要回滚的中间态；`cd ~/secure/<name>` 可以进入（看到两个哨兵），`cd ~/secure/<name>/work` 报 ENOTDIR；写进 `~/secure/<name>/` 本身的文件会让下次挂载被拒（多余条目）。
- 挂载要加 `-nonempty`。挂载前在 `mount.lock` 内确认 `<mnt>/` 下**恰好**只有这两个哨兵：用 lstat 逐项核对是普通文件、0 字节、0400、属于本 uid。有多余条目或属性不符就拒绝（78）并列出。
- `<mnt>` 位置规则（`checkLayout` 与 `createLayout` 共用，评审 L0 #1 + 复审 r2 A1 修订）：`<mnt>` 须为本用户 0700 目录、不是符号链接；**祖先链**——从 `dirname(<mnt>)` 一路到 `/`（含 `/`）的每一级都须是真实目录（不得是符号链接/文件，符号链接层级直接拒绝，保证词法链＝物理链）、属本 uid 或 root、且不得对组/其他可写；写位规则**唯一例外**是「属主为 root 且带 sticky 位」的目录（如 `/tmp`——sticky 下只有子项属主能改名它）；**没有任何无条件豁免**：`$HOME` 本身（例如组可写的共享 home）与其全部上级都按同一规则核查，违反即拒绝并打印是哪一级、为什么。缺省 `~/secure` 不存在时由 init 以 0700 创建，其他位置不代建。`<mnt>` 与 `<dir>` 的**词法与物理地址**（物理地址＝最近存在祖先的 realpath＋剩余尾段，永不对挂载点本身 realpath）都不得互相包含、不得与任何其他已登记库的 dir/mnt 两两互相包含（A 含 B、B 含 A 全查）、不得进入或包含 pi agent 目录（agent 目录同样做 realpath 规范化）——父目录符号链接（如 `~/agent-alias → ~/.pi/agent`）无法借此把挂载点偷渡进禁区。
- **挂载点身份固定**（评审 L0 #2 + 复审 r2 A2/A3）：挂载前在 `mount.lock` 内以 `O_DIRECTORY|O_NOFOLLOW` 打开挂载点并 fstat，pin 携带 `(dev,ino)`、**挂载前的物理路径**（realpath，此时安全）与**父目录 `(dev,ino)`**，fd 跨 gocryptfs 生命期持有；每次口令尝试前复检路径仍指向该 inode；挂载成功后**四条全部满足**才放行：(a) `readlink /proc/self/fd/<pin>` 仍等于 pin 的物理路径（fd 链接跟随改名——把内核实际挂载的对象绑定回受检 inode）；(b) mountinfo 存在挂载点 == 该物理路径、fstype `fuse.gocryptfs`、source == 本库 cipher 的条目；(c) 父目录 `(dev,ino)` 未变；(+) `stat(<mnt>).dev` == 该 mountinfo 行的 fuse `maj:min`。任一不满足 ⇒ 失败并**回滚**：`unlockVault` 对 `doMount` 抛出的失败同样先探测再卸载本次新建的挂载（`fusermount3 -u`，EBUSY 再 `-uz` 一次）；`already`（本次调用前已存在的挂载）保持原样不回滚。
- **残留窗口（如实）**：(i) pre-check 与内核在 gocryptfs 内解析路径之间仍可发生改名，mount.lock 只串行化合作启动器、不阻止文件系统改名；在祖先链全部合规（各级属本 uid 或 root、无组/其他写位、sticky 仅豁免 root 属主）的前提下，其他 uid 无法替换链上任何一级，因此该窗口的利用者只能是本 uid 进程——与 R16（同 uid 对抗不在承诺内）同类；若祖先链前提本身被破坏（如 root 配合），检测能力限于上述 (a)(b)(c)(+)，不保证检出所有错位。(ii) fd 持有引用不等于 gocryptfs 经该 fd 挂载——内核按路径解析挂载，(a) 证明的是「受检 inode 仍在原路径」，在正常时序下把它与实际挂载对象绑定。
- 物理路径：`realMnt = join(realpath(dirname(mnt)), basename(mnt))`——**永不对挂载点本身做 realpath**（挂载着或 ENOTCONN 时会穿过/卡住）；`realWork = <realMnt>/work`。
- 哨兵只保护 `work/` 和 `state/` 两个前缀；`<mnt>/` 下其他文件名不在保护范围内，本方案也不会用到它们。
- `init` 中途失败时会留下**两处**产物（元数据 `<dir>` 与挂载点 `<mnt>` 及其哨兵），失败提示与 `status` 的 `incomplete` 恢复指引都列出两个位置、只给命令不自动删除；清理挂载点前须确认未挂载、其内只有 `work`/`state` 两个哨兵且无要保留的数据，有多余条目时只提示人工核查（评审 L0 #4）。
- **旧布局条目（pre-L0，§L.3 只读兼容）**：条目含 `link` 键、或不含 `mnt` 且 `<dir>/mnt` 是目录 ⇒ 解析为 `layout:"legacy"`（按旧规则派生路径），并保留 `legacyLink`（条目 `link` 的合法展开值，缺省/非法时回落旧缺省 `~/secure/<名字>`）——它只进 D4 的已知地址集合（`vaultSpellings`/`vaultOfPath`），使普通会话经旧入口的 bash/路径工具访问在旧库仍被旧版 helper 挂着时照样被拦（评审 L0 #3），不参与任何启动器路径逻辑。`status`/`lock`（以及后续包的 `export`）可用；`unlock`/`run`/`init --fix-settings` 拒绝（78）并提示「无数据删掉重建；有数据 export→import」。插件侧旧库 domain 判定保持旧行为（cwd 在旧挂载点下且挂载着 ⇒ secure；未挂载 ⇒ locked）。

### 2.2 命令面

**启动器 `pi-secure`**（`src/secure/bin/pi-secure`，bash；`src/secure/bin/helper.mjs`，纯 Node、无依赖）。它不劫持 `pi` 这个名字，也不会自动透传成普通的 pi。
安装方式：`/secure status` 会打印 `ln -s <包路径>/src/secure/bin/pi-secure ~/.local/bin/pi-secure`，由用户自己执行。启动器用 `readlink -f "$0"` 定位 `helper.mjs`。

| 命令                                            | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-secure init <name> [--path <挂载点>]`       | 前置检查（gocryptfs ≥1.8、fusermount3、flock、Linux）→ 建立 §2.1 布局（哨兵 + `mount.lease`，`--path` 指定挂载点位置，L0 起不再建入口符号链接）→ `gocryptfs -init -- cipher`（终端提示两次口令，并打印 master key，Q1）→ 首次挂载 → 建 `work/`、`state/…`，并写 `work/.pi/settings.json` 的 `sessionDir`（§2.3）→ 卸载 → 提示清屏。失败处理（2026-10-24 裁定，见 [init-cleanup-report](./init-cleanup-report.md)）：`gocryptfs -init` 失败 ⇒ 自动删除本次创建且身份已记录的对象并撤销登记；首次挂载口令连错 3 次（77）⇒ 在终端询问是否删除（master key 作废），默认保留，用 `init <name> --fix-settings` 补齐 |
| `pi-secure unlock <name>`                       | 在 `flock -o -w 10 mount.lock` 下（`-o`：flock 在 exec 子命令前关闭锁 fd，gocryptfs 守护进程不会继承这把锁；P0 验证 unlock 返回后 lock 仍能拿到锁）：已挂载就直接返回；否则做哨兵校验，再 `gocryptfs -nonempty -- cipher mnt`。口令由 gocryptfs 自己从 TTY 读取，toolkit 不经手；exit 12 时最多试 3 次（D9）。之后核对 mountinfo（`fuse.gocryptfs`，source 是 cipher），再幂等补写 `work/.pi/settings.json` 的 `sessionDir`（§2.3）。顺带打印 swap/core 警告                                                                                                                                                  |
| `pi-secure lock <name> [--lazy]`                | 执行 §2.5 的「有界收尾」（统一 10 秒预算）：`cd /` → 占用扫描 → 加锁卸载（`--lazy` 时加 `-z`）。若 EBUSY、超时或预算耗尽，打印占用者和建议后返回，不会卡住                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pi-secure status [<name>]`                     | 挂载状态、布局完整性、gocryptfs 版本、cwd 在挂载内的进程、swap/core 警告、traffic-record 适配情况（D5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pi-secure run <name> [-C <子目录>] [pi 参数…]` | `unlock` → `cd <work>/<子目录>` → 参数审查（§2.2.1）→ `ulimit -c 0; umask 077` → 设置环境变量 `PI_SECURE_VAULT=<name>`、`PI_SECURE_SESSION=1` → **以子进程方式**运行 `pi --session-dir <state>/sessions/default "$@"` → pi 退出后执行 §2.5 的有界收尾 → 以 pi 的退出码退出                                                                                                                                                                                                                                                                                                                                    |

转换与迁移命令 `convert` / `export` / `import`（含 `--resume` / `--abort`）与 `init --fix-settings` 迁址见 §2.9。

插件内只有一个只读命令 `/secure status`（web 允许）。另有状态栏标记 `secure` / `secure:locked`（英文 token，遵守 UI 约定）。

#### 2.2.1 `run` 的参数审查（修复复审 Blocker）

- `run` 的安全域由 `<name>` **显式指定**，不存在「先判定成普通域再直接 exec pi」的分支，复审指出的 `pi-secure --fork <vault 会话>` 明文路径因此不存在。
- 审查**复用 pi 自己的解析器**：`helper.mjs` 通过 `import(pathToFileURL(<pi 包>/dist/cli/args.js))` 调用 `parseArgs`，语义与 pi 一致。pi 包位置由 `readlink -f $(command -v pi)` 上溯到包根目录。
  解析结果结构变化时直接拒绝（fail closed），并在 conformance 里钉住。
- 规则（基于 parseArgs 的结果）：
  - `--session-dir` 只要**出现**就拒绝（按字段是否存在判断，`--session-dir ""` 同样拒绝）。原始 argv 的 `--` 边界保持不变。
  - `session` 是路径时（与 pi `main.js:192-215` 的规则相同：含 `/`、`\` 或以 `.jsonl` 结尾），必须位于 `<state>/sessions/` 下，否则拒绝；是 id 时放行（只在 `--session-dir` 内查找）。
  - `fork`（无论路径还是 id）：放行，效果是把会话复制**进** vault。
  - `fileArgs`（`@file`）：放行，效果是读进 vault 内的会话。
  - `noExtensions` 拒绝，因为守护依赖插件；`-e/--extension`（追加扩展路径）也拒绝，这是务实版的简化。
  - `export`：拒绝，导出请在会话内执行 `/export`，默认写到 cwd。
  - `noSession`：**放行**，此时不写会话。插件对非持久化会话免检会话文件和会话目录（§2.4 第 3 步），验收加一条 `run --no-session -p`。
  - 其余参数原样传给 pi。

### 2.3 项目级 sessionDir

`init`、`unlock`、`run` 都会**幂等**写入 `<work>/.pi/settings.json`：`{"sessionDir": "<mnt>/state/sessions/default"}`。文件已存在时只合并 `sessionDir` 一个键；已有不同的值时：`run`/`unlock` **拒绝启动**并提示（给出 `pi-secure init <name> --fix-settings` 一键改写为 vault 内路径，改写前备份原文件为 `settings.json.bak-<时间戳>`），避免 rsync 带入的旧 `sessionDir` 让会话写到库外。这样迁移项目时先复制还是先 init 都能收敛到同一结果（复审 r4 m3）。

效果：保险库挂载后，即使不用 `run`，**在项目根目录**直接执行 `pi`，会话也会写进 vault（pi 在信任判定前就读取这个键）。在子目录启动时这个设置不生效，此时插件会锁住会话，提示用 `pi-secure run <name> -C <子目录>`。

### 2.4 插件的轻量守护（`src/secure/`）

**两阶段域判定**（修复复审 #3）：

1. **activate 最开始**（在 `src/index.ts:178` 的 `readSettingsNoMigrate()` 之前）调用 `initSecureDomain()`。它只把设置文件的 `secure` 段读成原始 JSON（纯函数，与 helper 同源，用 parity 测试保证一致），然后判定：
   `vault = env PI_SECURE_VAULT ?? matchVault(realpath(process.cwd()))`。
   - 命中且 `mnt` 已挂载 ⇒ 冻结为 `{kind:"secure", vault}`，存到 `Symbol.for("pi-subagent:secure-domain")`，同时：先把覆盖前的原值存进 `PI_SECURE_ORIG_ENV`（JSON：`{"TMPDIR": <原值或 null>, "ARMORY_MEMORY_ROOT": <原值或 null>}`，只在尚未设置时写入），再设置 `process.env.TMPDIR=<state>/tmp`、`ARMORY_MEMORY_ROOT=<state>/memory`、`PI_SECURE_SESSION=1`。
   - 命中但未挂载，或 `PI_SECURE_VAULT` 无效 ⇒ `{kind:"locked"}`。
   - 未命中 ⇒ `{kind:"plain"}`。
   - 子会话在同一进程里激活，直接读这个冻结值。
2. **settings 覆盖**：`loadSettings(source)` 结束时，若域是 `secure`，强制以下取值（覆盖用户设置）：
   - `bashJobs.dir = <state>/bash-jobs`（`stack.ts:783-793` 与 `:3324`、`bash/child.ts:262` 一起跟随）
   - `workflow.journalDir = <state>/workflows`
   - `fabric.crossSession.enabled = false`
   - `externalAgents.droid.enabled = false`
   - `feishuNotify.enabled = false`

   两个设置加载入口都会经过这里。覆盖时先**克隆**要改的嵌套对象，不能污染 `DEFAULT_SETTINGS`。关闭 secure 的 golden 同时断言默认设置和 `process.env` 都没被改动。

3. **session_start 时核验**（只对 secure 或 locked 域执行；plain 域只检查「会话文件或 cwd 是否落在某个 vault」）：取会话的 cwd（`ctx.cwd`）和会话文件。**非持久化会话**（`getSessionFile()` 为 undefined 且 `getSessionDir()===""`，即 `--no-session`）免检会话文件和会话目录，仍检查 cwd 与挂载。
   - 会话所属 vault 与冻结域不一致（例如普通进程用 `--session` 打开 vault 会话，或 secure 进程的会话 cwd 不在 vault 内），或者 `sessionManager.getSessionDir()` 不在 `<state>/sessions/` 下 ⇒ **LOCKED**。
   - 冻结域为 `locked` ⇒ **LOCKED**。

**LOCKED 时的行为**：

- `input`（所有来源）一律 `handled`；`tool_call` 一律 block；`user_bash` 返回拒绝。
- notify 原因和修复办法，例如「请用 `pi-secure run acme -C sub` 重开」。
- **不自动 shutdown**，用户可以 `/quit`。
- pi 原生的斜杠命令照常可用（扩展拦不到，见 R4）。

### 2.5 拦截点（D2–D4、D8）与退出

| 拦截                | 位置                                                                                                                                                                                            | 行为                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2 worktree         | `src/extensions/worktree.ts` 的 H2                                                                                                                                                              | 域为 secure ⇒ 抛 `failed(config)`：「加密会话不支持 worktree 隔离」                                                                                                                                                                                                                                                                                                                                                         |
| D3 containWrites    | `tool_call`：write/edit                                                                                                                                                                         | secure 时，目标路径（解析到最近的已存在祖先后取 realpath）不在 vault 内 ⇒ block（TMPDIR 本来就在 vault 内）                                                                                                                                                                                                                                                                                                                 |
| D4 foreignAccess    | `tool_call`：read/write/edit/grep/find/ls/bash                                                                                                                                                  | plain 时，路径在任一 vault（`<dir>` 或用户入口路径）内 ⇒ block；bash 命令字符串里出现这些前缀 ⇒ block（尽力而为）                                                                                                                                                                                                                                                                                                           |
| 子会话落盘          | `src/runtime/session-driver.ts:858`                                                                                                                                                             | secure ⇒ `SessionManager.create(cwd, <state>/sessions/default)`                                                                                                                                                                                                                                                                                                                                                             |
| 跨域 resume / 切换  | `session-driver.ts:885-897` resume；`session_before_switch`                                                                                                                                     | secure 时目标文件不在 vault 内 ⇒ 拒绝或取消；plain 时目标在 vault 内 ⇒ 拒绝或取消。new、fork、tree 沿用当前 sessionDir，在 secure 进程里本就落在 vault 内；`/import` 的来源路径看不到（R5）                                                                                                                                                                                                                                 |
| consult fork        | `fork-store.ts` 与 `stack.ts:3056-3076`                                                                                                                                                         | secure ⇒ 目录为 `<state>/consult`。创建、main fork、`removeForkFile`（`fork-store.ts:808` 的默认 `dir` 参数）、sweep、index **共用同一个根**，经 `consultSessionDir()` 统一按域返回                                                                                                                                                                                                                                         |
| D8                  | 设置覆盖（xs、droid、feishu-notify）；cron                                                                                                                                                      | secure ⇒ 不装配；`/agent schedule` 等创建入口拒绝；`src/index.ts:1433` 的 `stack.scheduler.start()` 在 secure 下**跳过**，已有任务不会被加载或 arm（`schedule/scheduler.ts:92-106`）                                                                                                                                                                                                                                        |
| env 清洗（复审 M1） | `src/web-hub/agent/launcher.ts:102-109`（`spawnHub` 唯一出口，3 个调用点见 `web-hub/agent/index.ts:1485,1905,1935`）；`src/web-hub/hub/spawn/supervisor.ts:1873-1877`（managed spawn 复制 env） | 新增纯函数 `hubSafeEnv(env)`（`src/secure/env.ts`，不依赖 pi）：删除 `PI_SECURE_*`；按 `PI_SECURE_ORIG_ENV` 恢复 `TMPDIR` 和 `ARMORY_MEMORY_ROOT`（原值为 null 则删除；缺少 `PI_SECURE_ORIG_ENV` 而 `PI_SECURE_SESSION=1` 时直接删除这两个变量）。spawnHub 改为 `env: {...hubSafeEnv(process.env), PI_WEBHUB_CONFIG…}`；supervisor 的循环再跳过 `PI_SECURE_` 前缀作为防御。secure 关闭或 plain 域下输出与输入相同（golden） |
| D5                  | 环境变量 `PI_SECURE_SESSION=1`（activate 时设置，整个进程不变）                                                                                                                                 | traffic-record 在**每次捕获前**读取它（不依赖扩展加载顺序，§2.6）                                                                                                                                                                                                                                                                                                                                                           |
| git 提醒            | session_start（secure 时），一次带超时的 `git rev-parse --git-common-dir`（`src/git/run.ts`）                                                                                                   | common-dir 不在 vault 内 ⇒ 警告（R9）                                                                                                                                                                                                                                                                                                                                                                                       |

**退出与卸载（有界收尾，复审 M2）**：

- 不使用旁车和租约（r2 的设计已撤销）。`pi-secure run`（pi 子进程退出后）和 `pi-secure lock` 走同一个函数 `finalize(budget=10s)`，由 `helper.mjs` 实现。`helper.mjs` 自带总截止：一个 unref 的 `setTimeout(process.exit, budget+500ms)` 硬性兜底；即便某个 fs 调用卡在 libuv 线程池里，进程照样退出。
  1. bash 侧先 `cd /`，确保启动器自身不占用挂载。
  2. **占用扫描**：遍历 `/proc/[0-9]*/cwd`，每项 readlink（只看得到本 uid 的进程）。预算为 `min(3s, 剩余)`，最多 4096 项；超出预算 ⇒ **跳过卸载**，告警「扫描超时，未卸载」。发现其他占用者 ⇒ 列出最多 10 个 pid，不卸载，返回。
  3. **加锁卸载**：spawn `flock -o -w <剩余-1s> mount.lock fusermount3 -u mnt`（`--lazy` 时加 `-z`）作为**一个**子进程。到截止时，对子进程组发 `SIGKILL`，然后 **unref、不等待它退出**（如果 fusermount 陷在不可中断的 D 状态，KILL 也收不回来，所以不能等）。
     结果分三种：成功 ⇒ 再核对 mountinfo；EBUSY ⇒「未卸载：稍后 pi-secure lock <name>」；超时 ⇒「卸载命令未在预算内完成，可能仍在后台」（R19）。
  4. 收尾最长 = budget + 0.5s，测试断言 ≤ 11s。以下三种注入场景都要覆盖：扫描超预算、锁被长期占用、卸载 helper 忽略 TERM 或一直不退出。
- 用 `pi-secure unlock` 加 `cd && pi` 启动的会话不会自动卸载，需要用户执行 `pi-secure lock`。
- 运行中被外部卸载时，后续写入撞上哨兵（ENOTDIR）失败，pi 可能报错甚至崩溃，但不会写进下层目录。

### 2.6 traffic-record 契约（P3，外部仓库）

- 契约：`process.env.PI_SECURE_SESSION === "1"` ⇒ 不持久化 request、message、response 的正文。实现要求在**每次捕获或入队前**读取这个变量，覆盖 request、message、stream chunk 和异步落库这几个点，而不是只在 activate 时检查一次。原因是 toolkit 在自己的 activate 里设置它，所以 `pi-secure run` 和项目根直接 `pi` 两种情况都能生效，不依赖扩展的加载顺序。
- `package.json` 声明 `"piSecure": {"honors": "PI_SECURE_SESSION/1"}`。`pi-secure status` 和 `/secure status` 检查 pi 设置里的 packages：存在 traffic-record 但没有这项声明 ⇒ 警告（D5）。

### 2.7 web-hub 的最小改动（复审 M1）

没有清洗时会出的问题：hub 可能由某个**加密会话**自动拉起或重启。这时它会继承 `PI_SECURE_VAULT`、`TMPDIR=<state>/tmp` 等变量，再通过 managed spawn 原样传给普通目录里新开的 web 会话。结果是那些普通会话被冻结成 secure 域，随即 LOCKED；hub 自己的临时文件也落在保险库里，保险库一卸载就失效。

修法只有两处接线，用的都是 §2.5 表里的 `hubSafeEnv`：

- `spawnHub`：hub 进程从此只拿到「进入 secure 之前」的环境；
- supervisor：managed spawn、restore、relaunch 共用的 forkInto env 循环。

托管的 vault 会话**不靠**继承来的环境，而是靠自己的 cwd 和项目 `sessionDir` 在 activate 时判定域，因此清洗不影响它们。hub 协议、能力表、路由都不变。

### 2.8 私有模式（`run --private`；L0 + N0–N4 已落地 2026-10-24）

把 gocryptfs 明文挂载放进一个**只属于本次 pi 进程树**的挂载命名空间：外部同用户进程按路径看到的 `~/secure/<名字>/{work,state}` 始终是两个哨兵文件（`cd` 进挂载点可见，`cd …/work` 报 ENOTDIR），全局 mountinfo 里没有这个挂载，`find`/`grep`/备份工具/其他 agent 的无意识访问都会被挡住。完整协议（释放协议、终止权、预算表、崩溃自愈矩阵、评审处置）见 [private-plan.md](./private-plan.md) r3/r3.1；实现偏差以 [L0](./L0-report.md)/[N1](./N1-report.md)/[N2](./N2-report.md)/[N3](./N3-report.md)/[N4](./N4-report.md) 报告为准。

**安全边界（软边界，如实）**：私有模式**不防**同一用户下有意的恶意进程——这类进程可以经 `/proc/<pid>/root`、`/proc/<pid>/cwd` 读到明文，或用 `setns` 加入该命名空间（conformance NC9 永远输出 KNOWN）。唯一硬边界是独立系统用户。`status` 的 `boundary:` 行与 `/secure status` 的「边界：」行用固定短句：「防路径直读/扫描/备份/其他程序的无意识访问；不防同 uid 定向进程（/proc/<pid>/root、setns）」；每次私有启动（含 setup）还在 stderr 打印一次边界长句（见 USAGE/README，措辞与 `helper.mjs` 的 `PRIVATE_BOUNDARY_LONG` 一致）。

#### 2.8.1 用法

| 命令                                                                      | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-secure run <name> [--private\|--no-private] [-C <子目录>] [pi 参数…]` | 新参数**只在紧跟 `<name>` 的位置识别**（固定顺序），其后 `-C` 仍只认第一个位置，其余原样交给 pi（§2.2.1 审查不变；两者同用 ⇒ 2）。未给出时取 `secure.vaults.<name>.private`（缺省 false）。私有路径：参数审查 → 前置检查（§2.8.6）→ 认领（写 `private.json` 实例记录 + 随机 `instanceId`，互斥检查在认领内、问口令前，§2.8.5）→ 建私有 ns 挂载 → 以真实 uid 启动 pi → pi 退出后在 ns 内收尾、ns 外经释放协议删记录 → **以 pi 的退出码退出**。每次启动打印边界长句；web-hub 未运行时另打一行提示（§2.8.4）。兼容例外（F1b）：`run acme --private …` 过去会把该参数交给 pi，现在被启动器消费 |
| `pi-secure run <name> --no-private`（私有登记库）                         | 照常普通挂载运行，但打印一行可见性提醒（全局挂载对所有同用户进程可见）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pi-secure unlock <name> [--global]`                                      | `private:true` 的库默认拒绝全局解锁（exit 64，提示改用 `run` 或 `--global`）；`--global` **只解除这条默认，从不绕过互斥**（§2.8.5 的闸门照常）。普通库接受 `--global` 且无差别；不带时 argv 规则与旧代码相同                                                                                                                                                                                                                                                                                                                                                                               |
| `pi-secure lock <name> [--lazy\|--kill]`                                  | `--kill` 只对私有实例有意义（对普通挂载等同不带参数并提示一行）。语义见 §2.8.3；`--lazy --kill` 同用 ⇒ 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pi-secure status [<name>]`                                               | 私有实例显示见 §2.8.3；无私有记录且租约空闲的库输出不变（N0 golden 钉住）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pi-secure init <name> [--path <挂载点>] [--private]`                     | 见 §2.8.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

设置：`secure.vaults.<name>.private`（boolean，缺省 false；非布尔 ⇒ invalid reason `"private"`，仅 `true` 时写出该键）。插件侧 ns 判定**基于证据**（`/proc/self/ns/mnt` 与登记库 `private.json` v3 的 `ns.mnt` 比对 + bootId），不依赖会被剥离的 env；`PI_SECURE_NS=1` 只是附加提示（证据 ∨ 提示，提示只会让判定更保守）。

#### 2.8.2 进程链与租约

```
shell ─ pi-secure(bash)
  └ P0  node helper.mjs run <name> --private     初始 ns · 真实 uid · TTY 前台进程组（认领/结果判定/删记录，不挂载）
      └ /bin/sh -c 'exec 9<>mount.lease && flock -n 9 || exit 213; exec unshare …'   shell 自己打开并锁住租约 fd 9，再 exec 成 unshare（不留包装进程）
          └ unshare --user --map-root-user --mount --propagation private
              └ P1  node helper.mjs __ns-root          ns-root 监督者：只挂载、收尾，不跑负载；持 fd 9
                  ├ node helper.mjs __mount-work        挂载内同步 fs 检查（可 KILL 的 worker，不给 fd 9）
                  ├ gocryptfs -fg -notifypid=<P1> …      setsid、显式 stdio 槽 9 ⇒ 持租约直到退出；口令由用户在 TTY 上直输 gocryptfs（不经 toolkit）
                  └ unshare --user --map-user=<uid> --map-group=<gid> -- pi …   真实 uid · CapEff=0 · 持 fd 9
                      └ bash 工具 / 后台 job / 子进程           同一 mntns；**不持 fd 9**（由 ns 成员扫描覆盖）
```

- **租约（互斥权威之一）**：`<dir>/mount.lease` 上的 flock——只要 gocryptfs 或任一 fd 9 持有者（P1、gocryptfs、内层 unshare→pi）还活着就被持有；**每一次** gocryptfs 启动（普通与私有）都在租约之下（内核保证同库至多一个 gocryptfs，I-P2）。fd 9 只由 shell 打开；Node 层只经**显式 stdio 槽 9** 交给 gocryptfs 与内层 unshare→pi（Node 会给继承 fd 置 CLOEXEC，`stdio:"inherit"` 传不过去——NC12 钉住）；pi 的后代不持 fd 9。
- **实例记录 `<dir>/private.json`**（v3，0600，≤4 KiB，明文区，不含口令与明文）：阶段 `starting → mounting → launching → session → finalizing`（setup 模式 `mounting → setup → finalizing`），每次变迁都是对 `instanceId` 的读-比较-写。**P1 从不删除自己的记录**（I-P3）：它完成 ns 内收尾后写 `inNsDone:true` 直接退出；由 ns 外的 P0/`lock`/认领经**释放协议**删除——真正取得租约（证明所有 fd 9 持有者已退出）∧ 持 `mount.lock` 且 instanceId 一致 ∧ 记录 ns 的成员扫描完整为空。唯一例外：从未建 ns 的 `starting` 记录由其 P0 在 `mount.lock` 内删除。
- **判活**不只看租约：只有「租约可获取 **且** 没有任何进程处于记录的 mount ns」才判 stale；任一证据表明仍有成员 ⇒ 不释放、不允许新挂载（fail closed）。**终止权只来自记录**（I-P4′，r3.1 收紧）：只有通过完整成员授权（bootId 一致 ∧ mnt ns = 记录 `ns.mnt` ∧ user ns ∈ {`ns.user`, `ns.innerUser`} ∧ starttime ≥ `supervisor.start` ∧ 到记录身份锚点的 ppid 链）的成员才会被信号，每个信号前同步复验；扫描发现的「未登记持有者」与无法证明归属的进程只报告（`unrecorded`/`ns-in-use`）、阻止新挂载，绝不杀。
- **有界**：监督者从不在挂载路径上做同步 fs（挂载内操作全部放进可 KILL 的 worker）；各阶段预算化（gocryptfs 每次尝试 180 s、记录变迁 ≤2 s、ns 内收尾 10 s 硬兜底 10.5 s、外部收尾 10 s 硬兜底 10.5 s），最坏路径 ≤22 s（不含口令输入与会话本身的生命期）。
- 负载永远以真实 uid、零能力运行（I-P6）；不 unshare pid ns，全局 pid 一致。

#### 2.8.3 实例状态与 `lock`/`status`

实例状态（`privateInstanceState`，与**记录 phase** 是两回事）：`none` / `unrecorded`（租约忙但无记录）/ `unknown` / `corrupt` / `stale` / `starting` / `mounting` / `launching` / `session` / `finalizing` / `orphan`（supervisor 死、gocryptfs 活 ⇒ 租约必忙）/ `orphan-ns`（gocryptfs 死、ns 有成员）/ `ns-in-use`（有成员但无一可证明归属）。记录 phase 共六个（`starting`/`mounting`/`launching`/`setup`/`session`/`finalizing`）；**`setup` 只是记录 phase、不对应实例状态**——`launching`/`setup` 两个 phase 都折叠为实例状态 `launching`（`judgePrivateInstance`），展示上 `mounting` 并入 `private:starting`、`setup` 并入 `private:launching`（token 表）。**r3.1**（N4 F1 + 安全复审第 2 轮）：`session` 还要求 supervisor 存活；supervisor 判活三态——只有 `/proc/<pid>` 确已消失或 starttime 不符才算 dead，任何读取错误都是 unknown、按 alive 处理（判 session，不进 orphan，不发信号；`lock` 报「无法确认监督进程状态」76）。

`lock` 决策表（`lockPrivateDecision`）：

| 实例状态                                     | `lock`                                                                                  | `lock --lazy`                                                                          | `lock --kill`                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `none`                                       | 原普通路径，输出不变                                                                    | 同左                                                                                   | 同左 + 提示 `--kill` 只用于 --private 实例                                   |
| `starting`/`mounting`                        | 73「另一个 pi-secure 正在挂载」                                                         | 同左                                                                                   | 同左                                                                         |
| `launching`（phase `setup` 折叠于此）        | 76（同 session 文案）                                                                   | 76「会话尚未启动完成，稍后再试」                                                       | SIGTERM 给 P1：中止启动并收尾（pi 未启动时输出「已中止」），等记录消失 ≤10 s |
| `session`                                    | 76「会话仍在运行（pi pid N）：退出 pi 后自动收尾；--lazy 摘除…；--kill 结束会话并收尾」 | SIGUSR2 → P1 在 ns 内 `umount -n -l`，写 `lazyDetachedAt`，确认条目消失后 0 + 固定措辞 | SIGTERM 给 P1（TERM pi ≤5 s 后 KILL，再 ns 内收尾），等记录消失 ≤10 s        |
| `finalizing`                                 | 等记录消失 ≤10 s（期间与到期都复判，只有 orphan/orphan-ns 才转外部收尾）                | 同左                                                                                   | 同左                                                                         |
| `orphan`/`orphan-ns`                         | 外部收尾：终止有证明归属的成员后经释放协议删除                                          | 退化为 TERM gocryptfs 并**明确报告**这一退化                                           | 外部收尾                                                                     |
| `stale`                                      | 释放协议清理后 0「清理了失效的 --private 记录」                                         | 同左                                                                                   | 同左                                                                         |
| `unrecorded`/`ns-in-use`/`unknown`/`corrupt` | 76：列出持有者/未证明 pid（只报告），说明不会自动终止；确认后可手工 kill 或重启         | 同左                                                                                   | 同左                                                                         |
| 调用者在该 ns 内                             | 76「不能在私有会话内部收尾自己；退出 pi 即自动收尾」                                    | 同左                                                                                   | 同左                                                                         |

`--lazy` 的固定措辞（成功后）：「已在私有命名空间内摘除挂载路径。既有 cwd、已打开的文件和运行中的作业可能继续访问明文；插件会在下一次输入/工具调用时拒绝（LOCKED）。要真正结束访问请用 --kill」（R29 如实披露；目标已成立时不发信号直接报告）。

`status`（私有实例时在原库行后追加私有块）：库行 token `private[:starting|launching|finalizing|orphan|orphan-ns|stale-record|ns-in-use|corrupt-record|unknown]` 或 `lease:unrecorded`；`private:` 行（phase · pi/supervisor/gocryptfs pid · ns · since · id 前 4 位 · `mode setup`/`lazy-detached`）· `lease:` · `outside view:`（全局 mountinfo absent ∧ 哨兵通过 = `not mounted · sentinels ok`；全局也挂着 ⇒ `! global mount also present (conflict)`）· `ns members:`（超时 `n/a (incomplete)`）· 异常状态 `!` 提示行 · `boundary:` 短句。在 ns 内执行时 `outside view`/`ns members` 为 `n/a` 并追加 `(this process is inside the private namespace)`（ns 内对宿主同 uid 进程的 ns 链接一律 EACCES，扫描必然不完整）；挂载探测超时（hung）时跳过挂载点下的一切同步访问并显示超时提示行。普通会话的 `/secure status` 在 `<dir>/private.json` 存在时给库行追加「（存在 --private 实例记录，用 pi-secure status 查看）」；ns 内的 `/secure status` 固定追加两行：「私有命名空间：是（<名>）」与「边界：<短句>」。

#### 2.8.4 web-hub：ns 内永不拉起，`agent.nospawn.v1`

- **硬闸门**落在唯一出口 `spawnHub`（`src/web-hub/agent/launcher.ts`）：ns 内直接拒绝（返回 blocked，不 spawn），覆盖自动拉起/respawn/restart/start 的全部调用方。判定用独立的**闸门三态** `judgePrivateNsGate()`（in-ns / not-ns / unknown），**unknown 一律按 in-ns 处理**（fail-safe）：记录损坏/不可读、`PI_SECURE_NS=1` 但无匹配证据、自身 ns/boot_id 读不到、认领窗口（记录尚无 `ns` 字段）、ns id 跨 boot 碰撞、secure 配置不可用（坏 JSON/非法库条目 ⇒ 整表不可信）都进 unknown；闸门**每次使用时重新判定**（fresh，不依赖 activate 冻结的域 verdict），无 secure 配置时零 /proc、零文件 IO。
- ns 内 `acquireConnection` 追加一次性 notify（去重闭包，`/reload` 后的新 wiring 最多再发一次）：「本会话运行在私有挂载命名空间内，不会自动拉起 web-hub（它会被困在命名空间里并持有明文视图）。需要网页时，在普通终端的 pi 里执行 /webhub start。」（unknown 用独立诊断措辞 + `pi-secure status` 排查指引）。
- `/webhub`：`restart` 在任何停机动作**之前**拒绝（普通终端执行）；`stop` 放行；`start` 照常清 stop 标记并说明「本会话不会自行拉起」；`open` 只打印 URL、不调浏览器。
- 启动器提示（P0，进 ns 前、只打印）：`webHub.enabled === true` 且候选 socket 300 ms 内都连不上 ⇒ stderr 一行（setup 模式不打印提示，边界长句照常）。
- **版本替换循环（Q2）**：ns 内 agent 在 `capsExtra` 追加事实标记 `agent.nospawn.v1`（放在 `control === false` 提前返回**之前**，任何配置都发出；常量在 `src/web-hub/protocol/nospawn.ts`，不碰冻结的 version.ts）；hub 侧在 `onVersion` 处理版本观察前经现有 `registry.getCaps()` 查标记，带标记的 agent 不进 `supersede.observe`。旧 hub 不认该标记 ⇒ R25。
- hub 在 ns **外**处理 vault 会话照旧 fail closed（D1/R12 不变，Q8）：ns 内会话经 agent socket 实时显示正常；managed spawn 到哨兵 cwd 失败；restore/relaunch/网页 fork/preview 读 vault 路径失败（`/proc/<pid>/root` 被 preview 的 `VIRTUAL_ROOTS` 拒绝）。

#### 2.8.5 与全局挂载互斥、`--global`

「本库可能存在挂载」的判据 = 租约忙（`/proc/locks` 只读探测）**或**存在非 stale 的私有记录；全局 mountinfo 照旧识别普通挂载与旧 helper 的无租约挂载。问口令**之前**拒绝的组合：

| 已有状态 → 新操作                                                        | 结果（均为问口令前）                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本库普通挂载存在 → `run --private`                                       | 76「已普通挂载（对所有同用户进程可见）。先 lock，再 run --private；或去掉 --private」                                                                                                    |
| 本库普通挂载失效（ENOTCONN）且租约空闲                                   | 先 `fusermount3 -u` 清理再继续；租约忙 ⇒ 76（gocryptfs 仍活着）                                                                                                                          |
| **另一个已登记库全局挂载（含 stale）→ `run --private`**                  | 76（Q10）：「私有命名空间会复制这个挂载，且无法在其中单独拆除」——unshare 把全局挂载复制进新 ns（NC5），先 `lock` 另一库；A 私有运行中再普通解锁 B 不受影响（private 传播，不进 A 的 ns） |
| unshare 后 ns 内复查继承挂载                                             | 任何 `fuse.gocryptfs`（含未登记的）、他库挂载点上的挂载、本库挂载点已有挂载 ⇒ 76「私有命名空间继承了不应存在的挂载」（gocryptfs 未启动，N1 评审 #3）                                     |
| 私有实例运行中 → `unlock`（私有登记库，不带 `--global`）                 | 64：默认拒绝全局解锁（helper 在互斥检查**之前**，文案见 §2.8.1；与实例无关）                                                                                                             |
| 私有实例运行中 → `unlock --global` / 普通 `run` / 第二个 `run --private` | 76（租约忙或记录 ns 仍有成员；有记录时文案带 pi pid）                                                                                                                                    |
| 租约忙但无有效记录（未登记持有者）                                       | 一切挂载入口 76；`status` 显示 `lease: held (unrecorded)` 与持有者（只报告）；`lock` 不杀，给人工排查指引                                                                                |
| 失效记录（bootId 不符；或租约空闲 ∧ ns 扫描完整为空）                    | 认领/`lock`/普通 `unlock` 经释放协议删除后继续（stale 清理自愈）                                                                                                                         |
| 在私有 ns 内部执行 `lock`/`unlock`/`run`                                 | `lock` 76「不能在私有会话内部收尾自己」；其余按上表；`status` 正常并标注所在 ns                                                                                                          |

私有登记库（`private:true`）的 `unlock` 默认 64（全局挂载对所有同用户进程可见）；`--global` 只解除这条默认，之后走**完全相同**的挂载路径与互斥闸门（Q5）。普通 `__mount` 也套上了同一条租约链（租约被占 ⇒ 76、gocryptfs 不运行、不问口令），并有同样的问口令前记录/租约闸门。

#### 2.8.6 `init --private` 与前置检查

- `pi-secure init <name> [--path <挂载点>] [--private]`：`privatePreflight` 在**创建任何东西之前**跑（userns 不可用 ⇒ 69 且什么都没建）→ 建新布局（哨兵 + `mount.lease`）→ 登记 `private:true` → `gocryptfs -init`（仍打印 master key 一次，Q1）→ 首次挂载、建 `work/`、`state/…`、写项目 sessionDir、卸载**都在私有 ns 内完成**（P1 setup 模式，结束无任何挂载、租约空闲）；失败 ⇒ 码透传并提示再执行 `init --fix-settings` 补齐。`init <name> --fix-settings` 对私有库同样在 ns 内改写后卸载（普通库保持「改完保持挂载」）；`--fix-settings --private` 同用 ⇒ 2（是否私有由设置决定）。
- `privatePreflight()`（失败 ⇒ 69，列出具体项与「去掉 `--private` 仍可用普通模式」）：`unshare --help` 含 `--map-root-user`/`--map-user`/`--map-group`/`--propagation`；`unprivileged_userns_clone`（存在时）=1、`max_user_namespaces`>0；AppArmor `apparmor_restrict_unprivileged_userns`=1 ⇒ 保守拒绝（不检测 profile）；实测 userns 内 tmpfs 挂载（3 s）；`umount` 存在。
- `init --private` 库的迁移与手工操作步骤在 pi 会话里用 `!` 命令完成（r2 不提供 ns 内 shell，Q7；见 README）。

#### 2.8.7 退出码

私有模式下的退出码（统一表，与 [convert-plan](./convert-plan.md) §6 相同；65/74 只由转换与迁移命令产生，见 §2.9.8）：

| 码      | 私有模式下的含义                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0       | 成功（`run --private` = pi 的退出码透传；`lock` 清理/收尾成功；setup 模式成功）                                                                                                                                                                                    |
| 1       | 一般失败 / 用户中止（如 `lock --kill` 在 launching 阶段中止：pi 未启动，输出「已中止」）                                                                                                                                                                           |
| 2       | 用法错误（`--lazy --kill` 同用、重复 `--global`、`--fix-settings --private` 同用、`--private --no-private` 同用、需要 TTY）                                                                                                                                        |
| 64      | pi 参数被拒（§2.2.1，认领之前）；私有登记库不带 `--global` 的 `unlock`                                                                                                                                                                                             |
| 66      | 未找到保险库 / 文件                                                                                                                                                                                                                                                |
| 69      | 前置缺失：unshare 功能参数/userns sysctl/AppArmor 限制/probe 失败/`umount` 缺失；unshare 失败或 P1 自检失败（记录无 `ns` 字段的失败路径退出码取 `failCode`，缺省 69）                                                                                              |
| 73      | 锁忙（`mount.lock`/settings 锁等待超时）；`lock` 遇 `starting`/`mounting` 实例（「另一个 pi-secure 正在挂载」）                                                                                                                                                    |
| 75      | 预算耗尽 / 停滞看门狗 / 硬兜底（ns 内收尾未完成、worker 超时、外部收尾不完整、记录未能删除、`/proc/locks` 读不到的 fail closed）                                                                                                                                   |
| 76      | 占用或状态冲突：已普通挂载、租约忙（含未登记持有者）、私有实例运行中、另一库全局挂载（含 stale）、ns 继承了不应存在的挂载、`ns-in-use`/`unrecorded`/`corrupt`/`unknown`（含监督进程状态无法确认）、会话仍在运行（不带 `--kill` 的 `lock`）、在私有 ns 内部收尾自己 |
| 77      | 口令连错 3 次（1s/2s/4s 间隔）                                                                                                                                                                                                                                     |
| 78      | 配置错误：布局/位置规则/祖先链问题、未挂载时挂载点多余条目、sessionDir 冲突、旧布局（§2.1 legacy）、挂载点已存在、名字已登记等                                                                                                                                     |
| 130/143 | 被中断（pi 自身退出码透传；`lock --kill` 结束会话 ⇒ 143）                                                                                                                                                                                                          |
| 213     | **内部专用码**（shell 租约链的 `BUSY`，NC11 证实不在 gocryptfs 1.8 退出码集合内），对外一律映射为 76，不暴露给用户                                                                                                                                                 |

崩溃自愈（要点；全表见 private-plan §3.9）：P0 被杀 ⇒ P1 照常收尾，记录留待清理（stale）；P1 被杀 ⇒ gocryptfs 与 pi 继续持租约，P0 等 pi 退出后外部收尾；P0+P1 被杀且 pi 不怕 SIGHUP ⇒ `orphan-ns`，`lock --kill` 收尾；前台进程组被 SIGKILL ⇒ gocryptfs 已 setsid 存活 ⇒ `orphan`，`lock` 清理；全部被杀 ⇒ ns 销毁、租约释放、记录 stale；机器重启 ⇒ bootId 不符 ⇒ stale。正常退出路径不经过任何 75 分支（P0 的释放耗时 <1 s）。

### 2.9 转换与迁移（convert / export / import；V0–V8 已落地 2026-10-24）

设计、评审处置与测试矩阵见 [convert-plan](./convert-plan.md)（r3/r3.1）；各包实现记录见 `V0`–`V8-report.md`。本节是用户口径的摘要。

共同原则：

- **不删除任何源数据**。convert 把原目录改名为**只读备份**，回滚时只把备份改回原名、恢复权限，并把本次新建的库搁置为 `.aborted-<txid>`，从不删除新库。备份、旧会话、旧 memory 都由用户核对后自行删除（R26）。import 的数据源是包文件，从不修改。
- **只读预检先行**。凡能提前判断的拒绝，都在确认提示、名字认领、口令输入之前报错，零改动。这些拒绝包括：路径与内容规则、git、占用、空间，以及挂载点位置与祖先链（V8 起由第 0 步执行，与 init 用同一套 `positionProblems` / `mntAncestorProblems`，规则不放宽，第 2 步与 import 发布时的检查保留作纵深防御）。被拒时最多留下空的锁文件（`.convert.lock`、`.txn/import-<名字>.lock`）。
- **事务标记**。登记项带 `pending:"convert:<txid>"` / `"import:<txid>"`（转换或导入进行中、中断）或 `relocate`（迁址待完成）时，`run` / `unlock` / `export` 一律被拒（pending ⇒ 76，relocate ⇒ 78），插件按 locked 判定。`lock` 例外：确有挂载时允许卸载。
- **只创建新布局**。旧布局库（§2.1 legacy）只能 `export`，再 `import` 成新布局；`run` / `unlock` / `init --fix-settings` 对旧布局一律拒绝（78）。

#### 2.9.1 `convert`：把明文目录转成保险库

```
pi-secure convert <明文目录> [<名字>] [--path <挂载点>] [--no-sessions] [--sessions-from <目录>]… [--private] [--assume-unreadable-idle]
pi-secure convert --resume <名字> [--assume-unreadable-idle]
pi-secure convert --abort  <名字> [--assume-unreadable-idle]
```

- 必须有 TTY：要键入保险库名确认，要输三次口令（`init` 两次 + 挂载一次），master key 由 gocryptfs 打印一次。确认与口令都在原目录改名之前完成，之后没有交互；不提供跳过确认的参数。
- `<名字>` 缺省取目录名（小写化，非法字符换 `-`，截到 32 位）。`--path` 指定挂载点，缺省 `~/secure/<名字>`。`--private` 完成后登记为私有库（转换过程本身走普通挂载）。`--no-sessions` 跳过会话复制，`--sessions-from` 追加会话来源。
- **前置工具**：gocryptfs、fusermount3、flock、`getfattr`（attr 包）、支持 `-n -T` 的 coreutils `mv`、`sync -f`；树内有 `.git` 时还需要 git。缺任何一项 ⇒ 69。
- **收窄规则（全部拒绝，65）**：
  - 路径：源是符号链接；源不在 `$HOME` 之下，或落在 `$HOME/.*`、系统目录、某个保险库内，或包含 pi agent 目录。
  - 挂载点：树根或树内有挂载点。
  - 父目录：组/其他可写，或所在文件系统类型不在 ext4/xfs/btrfs/f2fs/tmpfs 之列。
  - 属主与特殊位：他人 uid 或非主组 gid、FIFO/socket/设备、setuid/setgid/sticky。
  - xattr、ACL、capability：发现任何一项即拒绝。
  - 链接：树外硬链接、逃出根的相对符号链接（指向树外的绝对链接只警告）。
  - git：linked worktree、树外的 gitdir/alternates/commondir/`core.worktree`。

  早检在原目录上做，**权威检查在冻结后的备份上做**。

- **占用**：同 uid 进程的 cwd、exe、fd 或映射落在树内 ⇒ 76。同 uid 但 `/proc` 读不到的进程（如 `sd-pam`、本用户的 `sshd`）会被列出：交互时必须答精确的 `y` / `yes` 才继续；非交互时必须显式带 `--assume-unreadable-idle`（只确认本次运行第一组）。否则 75。确认按 pid+starttime 绑定；之后每次再扫出现新进程都要重新确认。
- **流程**（convert-plan §1.4）：0. 早检，打印计划，键入名字确认；
  1. 写状态文件；
  2. 认领名字（`pending`）→ 建布局 → `gocryptfs -init` → 挂载；
  3. 原目录以 `mv -n -T`（`RENAME_NOREPLACE`）改名为 `<父目录>/<原名>.pi-secure-backup-<YYYYmmdd-HHMMSS>-<4位>`；
  4. 备份整树 `chmod a-w`；
  5. 冻结后再扫占用；
  6. 在备份上做权威检查，取基线；
  7. 从备份拷入 `<work>`；
  8. 经挂载读回逐项比对，`git fsck`；
  9. 写项目 sessionDir；
  10. 复制会话与 memory（源只读）；
  11. 持久化屏障（对密文文件系统做 `sync -f`）；
  12. 复核备份基线；
  13. 原路径建符号链接 → `~/secure/<名字>/work`；
  14. 清除 `pending`，写入 `origin` / `backup`（**唯一提交点**）；
  15. 收尾卸载，打印备份删除命令与残留提示。

  第 12 步之后如果暂停超过 5 秒（Ctrl+Z、休眠、调试器），第 13、14 步之前都会完整重新复核备份；不一致 ⇒ 回滚 74（`--resume` 中 ⇒ 76）。

- **完成之后**：原路径是符号链接。锁定时 `cd` 报 ENOTDIR；解锁后 `cd <原路径> && pi` 即是加密会话。已在运行的 pi 进程要重启才认得新的 `origin`。备份删除命令是 `chmod -R u+w -- '<备份>' && rm -rf -- '<备份>'`，SSD/CoW 上删除不等于擦除。

#### 2.9.2 `export`：导出密文包

`pi-secure export <名字> <文件.tar>`：

- 新、旧布局都可以导出。库必须未挂载、租约空闲、没有运行中的私有实例（否则 76）。登记带 `pending` ⇒ 76，带 `relocate` ⇒ 78。
- 全程持有 `mount.lock`：导出期间 `unlock` / `run` / `lock` 等 10 s 后得到 73。
- 包格式 `pi-secure-vault/2`：最小 ustar + pax（只承载 path/size/mtime）+ `MANIFEST.json`，链接只记在 MANIFEST 里。包只含密文与 `gocryptfs.conf`，不含哨兵、锁、租约。
- 先写 `<文件>.partial-<txid>`（0600），用 `link()` 发布：目标已存在 ⇒ 78，从不覆盖。
- 拿到包的人可以离线暴力破解口令（W8）；MANIFEST 带 `origRealWork`（R27）。

#### 2.9.3 `import`：导入为新库

`pi-secure import <文件.tar> <名字> [--path <挂载点>] [--verify-password]`，另有 `--resume <名字>` / `--abort <名字>`：

- 只针对新名字。挂载点位置与祖先链在认领之前检查（V8：包括缺省 `~/secure` 尚不存在的情况，此时检查它将挂在其下的那条祖先链）。
- **校验型读取**进暂存目录 `.<名字>.import-<txid>`。路径白名单、预算、头校验、MANIFEST 冲突表、`gocryptfs.conf` 严格模式都在这一步；链接只在暂存根内重建。任何异常 ⇒ 65，零残留，撤销登记。
- **发布**：把暂存内容移入自建的 `<dir>`，独占创建 `<mnt>` 并写哨兵，做布局校验与 `sync -f`；随后清除 `pending`，这是导入的提交点。
- 挂载点地址与包里的 `origRealWork` 不同 ⇒ 登记 `relocate`，迁址待完成（§2.9.4）。
- `--verify-password`（需要 TTY）：提交后立即走受控迁址并验证口令。连错 3 次 ⇒ 77，导入结果保留，提示 `init <名字> --fix-settings`。迁址的其他失败 ⇒ exit 1（导入已提交）。
- 提交前失败 ⇒ 只撤销本 txid 的暂存、目录与登记，74（内容不合格 ⇒ 65）。

#### 2.9.4 迁址：`init <名字> --fix-settings`

- 登记带 `relocate:{from, to, txid, phase}` 时，`init <名字> --fix-settings` 和 `import --verify-password` 是仅有的两个入口。步骤：
  1. 裸挂载（不做 postMount）；
  2. 改写 `state/sessions/default/*.jsonl` 的会话头 cwd、`parentSession` 与 `subagent:run` 的 `diag.sessionFile`；
  3. memory 目录从 `toSlug(from)` 改名为 `toSlug(to)`，目标已存在则不合并、只报告；
  4. 改写 `work/.pi/settings.json` 的 sessionDir；
  5. `sync -f` 后在 settings 锁内清除 `relocate`，然后卸载。

  每步更新 `phase`，崩溃后再次执行即从实际状态继续。

- 私有库在 setup 模式（私有命名空间）内完成，要求库未挂载、没有运行中的实例（否则 76）。
- 没有 `relocate` 时，`--fix-settings` 照旧只幂等补写项目 sessionDir。

#### 2.9.5 `status` 显示项（`pi-secure status [<名字>]`；有对应键或文件时才出现，否则输出与原来逐字节相同）

| 行                                                                                                      | 含义与处置                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `  pending: convert:<txid> · …` / `  pending: import:<txid> · …`                                        | 转换或导入未完成：`pi-secure convert\|import --resume\|--abort <名字>`；期间 run/unlock/export 被拒    |
| `  relocate: pending (<phase>) · <from> → <to> · pi-secure init <名字> --fix-settings`                  | 迁址待完成（§2.9.4）                                                                                   |
| `  origin: <原路径>`                                                                                    | convert 完成后原路径符号链接的位置（插件 D4 拼写表据此加入原路径写法）                                 |
| `  backup: <备份> (still present) · 确认保险库内容无误后自行删除：chmod -R u+w -- '…' && rm -rf -- '…'` | convert 留下的只读备份**仍存在**；删除后这一行消失                                                     |
| `  ! 保险库 <名字> 的事务键损坏（…），按锁定处理…`                                                      | 登记项里 `pending`/`relocate`/`origin`/`backup` 形状非法：保险库保留但按 locked 处理，人工核对设置文件 |
| `convert <名字>: interrupted (<phase>) · --resume\|--abort`                                             | `.txn/convert-<名字>.json` 存在（§2.9.6）                                                              |
| `import <名字>: interrupted (<phase>) · --resume\|--abort`（或只 `· --abort`）                          | `.txn/import-<名字>.json` 存在；`state file unreadable (…)` ⇒ 人工检查该文件                           |
| `aborted: <路径> · 回滚留下的副本（…），核对后可自行删除`                                               | convert 回滚搁置的新库（§2.9.7）                                                                       |
| `  ! 保险库 <名字> 使用旧布局…`                                                                         | 旧布局只能 status/lock/export；迁移：`export` 后 `import` 为新名字                                     |
| `warn: 测试用环境变量已设置：…`                                                                         | 环境里有 `PI_SECURE_TEST_*`（含门控本身）：真实使用前 unset（§5 转换相关说明 3）                       |

会话内的 `/secure status` 对 pending / relocate / origin / backup 显示同样的库行。

#### 2.9.6 中断恢复：`--resume` / `--abort`

恢复判定只看**实际状态**：逐项 lstat 原路径、备份、库目录、挂载点，比对 dev+ino。阶段名只决定允许哪种动作。

| 命令                      | 允许条件                                                                                | 动作                                                                                                                                                                                                                 | 结果                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `convert --resume <名字>` | `phase ∈ {synced, linked}`，且 `pending` 属于本 txid（或 linked 且已提交）              | 复核备份基线（含 >5 s 暂停后重验）→ 原路径建链接（被占用 ⇒ 76，不覆盖）→ 提交 → 清理状态文件                                                                                                                         | 0；`claimed`/`renaming`/`backed-up` 或基线不符 ⇒ 76，提示 `--abort`                |
| `convert --abort <名字>`  | 登记仍带本 txid 的 `pending`（提交后一律拒绝 ⇒ 76「转换已完成，不能撤销；备份仍在 …」） | 删除我们建的链接 → 按 `.modes` 恢复备份权限 → `mv -n -T` 改回原名（原路径被占用 ⇒ 备份原样保留并报告）→ 新库在确认卸载、身份一致、无占用时改名为 `.aborted-<txid>`（本次建的空挂载点可直接 rmdir）→ 撤销本 txid 登记 | 全部完成 ⇒ 「已回滚」exit 1；任何一步未完成 ⇒ 74，保留状态并列出剩余项，可重复执行 |
| `import --resume <名字>`  | 已发布、登记仍带本 txid 的 `pending`                                                    | 重新执行登记（含 relocate），完成提交                                                                                                                                                                                | 0；其他阶段 ⇒ 1，提示 `--abort`                                                    |
| `import --abort <名字>`   | 未提交                                                                                  | 按身份删除本 txid 的暂存目录、`<dir>`（须未挂载）、`<mnt>`（只含两个哨兵），然后撤销登记                                                                                                                             | 0；已提交 ⇒ 1（「导入结果保留，未删除任何东西」）；有剩余 ⇒ 74                     |

convert 第 14 步之前的 SIGINT/SIGTERM/SIGHUP ⇒ 执行对应回滚，退出 130/143，文案说明实际结果；回滚未完成时提示 `--abort`。监督者被 `kill -9` 时状态文件保留，`status` 显示中断，用 `--abort` 收尾（`synced` 之后也可以用 `--resume`）。

#### 2.9.7 留下的目录：`.aborted-<txid>` 与 `.init-failed-*`

| 名字                                                                       | 来源                                                                                                                                                                  | 内容                                                                            | 清理                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<dir>.aborted-<txid>`、`<mnt>.aborted-<txid>`（与原位置同级）             | convert 回滚 / `--abort` 从不删除新库，以 `RENAME_NOREPLACE` 搁置                                                                                                     | 本次拷入的密文（明文内容与备份相同）与元数据；挂载点副本通常已被 rmdir          | `status` 的 `aborted:` 行会列出（查找范围：缺省父目录与已登记库的父目录；自定义 `--path` 且登记已撤销时只在 `--abort` 输出中出现）。确认源目录已复原后 `rm -rf -- '<路径>'`（遇只读目录先 `chmod -R u+w`） |
| `<dir>.init-failed-<YYYYMMDD-HHMMSS>-<4位十六进制>`、`<mnt>.init-failed-…` | `init`（以及同名并发的 init / convert / import）在建骨架后**输掉了名字认领**：本次建的骨架整体改名搁置，不做任何 unlink/rmdir；身份变化或目标名被占用时原样保留并报告 | 只有本次新建的骨架（空 cipher 或刚 `-init` 的配置、哨兵、锁文件），没有用户数据 | init 的输出会打印路径；`status` 不列出。确认不是自己要的库后 `rm -rf -- '<路径>'`                                                                                                                          |

备份（`<原名>.pi-secure-backup-<ts>-<4位>`）不在此列：它是用户原数据的只读副本，工具从不修改、从不删除，只在 `status` 里持续提醒。

#### 2.9.8 退出码（转换与迁移命令）

统一表见 [convert-plan](./convert-plan.md) §6；下表只列这三个命令及迁址实际会用到的含义。0 = 成功（含 `import --abort` 完成）；1 = 取消 / `convert --abort` 已回滚 / import 已提交但迁址未完成 / `import --resume` 拒绝 / 对已提交的导入 `--abort`；2 = 用法错误或需要 TTY；65 = 源目录或包内容不合格。

| 码  | 含义                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 64  | 不由这三个命令产生（`run` 的 pi 参数被拒、私有库不带 `--global` 的 `unlock`）                                                                                                                                                             |
| 66  | 源目录 / 包文件 / 保险库不存在；`--resume` / `--abort` 找不到状态文件                                                                                                                                                                     |
| 69  | 前置缺失：gocryptfs、fusermount3、flock；convert 另需 `getfattr`（attr 包）、git（树内有 `.git` 时）、`mv -n -T`、`sync -f`                                                                                                               |
| 73  | 锁忙：转换锁 `.convert.lock`、settings 锁、import 事务锁、`mount.lock`。导出全程持有 `mount.lock`，此时 `unlock` / `run` / `lock` 等 10 s 后得到 73，文案仍是「另一个 pi-secure 正在挂载或卸载」（§5 转换相关说明 1）                     |
| 74  | 拷贝、校验、IO、持久化屏障失败或空间不足，已回滚；第 13/14 步前的复核发现备份被改（>5 s 暂停后），已回滚；回滚**未完成**（附剩余项，状态保留）；convert 提交失败（保留状态，`--resume` 完成）；改名结局未知                               |
| 75  | 有界性：占用扫描超时、过多或失败；无法检查的同 uid 进程未获确认；worker 60 s 无进展；遗留 worker 进程组无法证明已结束                                                                                                                     |
| 76  | 占用或状态冲突：源或备份被占用；原路径在窗口内被重新占用；`convert --resume` 的阶段、基线、身份不符；对已提交的转换 `--abort`；export 时库已挂载、租约忙或私有实例运行中；登记带 `pending` 时的 run/unlock/export；已有未完成的转换或导入 |
| 77  | 口令连错 3 次：convert 挂载新库时（回滚）；`import --verify-password`（导入保留，迁址待完成）；`init --fix-settings`                                                                                                                      |
| 78  | 配置错误：名字已登记；目录或挂载点已存在；**挂载点位置或祖先链不合规**（V8 起在第 0 步）；状态文件不合法或与登记不符；`relocate` 未完成时的 run/unlock/export；旧布局；导出目标文件已存在；设置文件损坏                                   |

---

## 3. 失败模式

| 场景                                                                | 行为                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| gocryptfs 未安装、版本低于 1.8、非 Linux、缺少 fusermount3 或 flock | `pi-secure` 报错，给出安装提示；插件把配置中的 vault 一律当作未挂载（cwd 命中即 LOCKED） |
| 哨兵校验失败、mountinfo 不符、布局不完整                            | 拒绝挂载，列出问题                                                                       |
| 口令连错 3 次                                                       | 退出码 77                                                                                |
| `mount.lock` 等待超时（10s 或 5s）                                  | 报「另一个 pi-secure 正在挂载或卸载」，退出（导出期间同样如此，§5 转换相关说明 1）       |
| 守护进程崩溃（ENOTCONN）                                            | `status` 报 `stale`；`unlock` 时先 `fusermount3 -u` 再重新挂载                           |
| `run` 被 SIGKILL                                                    | 不卸载，挂载会残留，`status` 能看到                                                      |
| 设置中 `secure` 段非法                                              | 该 vault 判为 `invalid`；cwd 命中时 LOCKED                                               |

---

## 4. 明文去向处置（务实版做到的部分）

| 去向                                      | 处置                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 主会话 jsonl                              | `run` 传 `--session-dir`，或项目设置的 `sessionDir`，落在 vault 内                   |
| 子会话、consult fork                      | 落在 `<state>/…`                                                                     |
| bash job 日志与记录、workflow journal     | 设置覆盖到 `<state>/…`                                                               |
| memory                                    | `ARMORY_MEMORY_ROOT=<state>/memory`                                                  |
| pi 的临时输出、外部编辑器、剪贴板临时文件 | `TMPDIR=<state>/tmp`                                                                 |
| session-nav provenance 缓存               | sessionDir 是 `<state>/sessions/default`，缓存根自动变成 `<state>/cache`（单测钉住） |
| feishu-notify、xs、droid、cron            | D8 关闭                                                                              |
| traffic.db                                | P3 落地后不写                                                                        |

---

## 5. 已披露残留清单（务实版**不防**）

| #   | 路径                                                                 | 影响（一句话）                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 用户可采取的缓解                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | crashes.json                                                         | pi 崩溃时把 error.message 和 stack 原样写进 `~/.pi/agent/crashes.json`，可能含会话片段                                                                                                                                                                                                                                                                                                                                                                                  | 崩溃后检查并删除相关记录；备份时排除该文件                                                                                                                                                       |
| R2  | swap / hibernate                                                     | 内存页（含口令、明文）可能换出到未加密的 swap                                                                                                                                                                                                                                                                                                                                                                                                                           | 用加密 swap 或 zram（且不开 writeback），或关闭 swap；`pi-secure status` 会提示                                                                                                                  |
| R3  | core dump / apport                                                   | 管道型 core_pattern（本机是 apport）不受 `ulimit -c 0` 限制，崩溃转储可能落进 `/var/crash`                                                                                                                                                                                                                                                                                                                                                                              | 关闭 apport（`sudo systemctl disable --now apport`），或把 `kernel.core_pattern` 改为非管道并保持 `ulimit -c 0`；`status` 会提示                                                                 |
| R4  | pi 原生 `/debug`、`/export <库外路径>`、`/share`、`/copy`            | `/debug` 把全部消息写进 `~/.pi/agent/pi-debug.log`；其余三项分别写出、上传 gist、进剪贴板                                                                                                                                                                                                                                                                                                                                                                               | 加密会话里不要用这些命令；用过 `/debug` 后删除 `pi-debug.log`；`/export` 不带参数（默认写到 cwd，在 vault 内）                                                                                   |
| R5  | 普通会话里 `/import <vault 会话>`                                    | pi 只给扩展暴露目标路径，会把 vault 会话完整复制进明文目录                                                                                                                                                                                                                                                                                                                                                                                                              | 不要从普通会话导入 vault 会话；导入一律在 `pi-secure run` 里做                                                                                                                                   |
| R6  | 绕过 `pi-secure` 直接用 `pi`                                         | 已挂载时，在子目录里执行 `pi --fork/--session <vault 文件>` 或带 `@vault/文件`，会在扩展加载前（或作为普通会话的初始消息）写出明文；未挂载时无法 `cd` 进入 vault                                                                                                                                                                                                                                                                                                        | 一律用 `pi-secure run`。只有在已挂载、位于项目根目录、项目 `.pi/settings.json` 的 `sessionDir` 仍在，且没有被 `--session-dir` 或 `PI_CODING_AGENT_SESSION_DIR` 覆盖时，直接 `pi` 才落在 vault 内 |
| R7  | 跨域 fork / import / 结果搬运                                        | 把 vault 会话或文件内容通过任意途径（复制粘贴、`@file`、手动 cp）带进普通会话或普通目录                                                                                                                                                                                                                                                                                                                                                                                 | 只能靠操作习惯；D4 只拦工具层的直接读取                                                                                                                                                          |
| R8  | bash 写到外部                                                        | `cat secret > /tmp/x`、`curl -d @file …`、脚本自身落盘，D3 只管 write/edit                                                                                                                                                                                                                                                                                                                                                                                              | 不让模型在加密会话里跑会外写的命令；需要的话审阅 bash 调用                                                                                                                                       |
| R9  | git common-dir 或远端                                                | 项目若是 linked worktree，或 `.git` 指向 vault 外，commit 的对象会写到外面；push 会上传                                                                                                                                                                                                                                                                                                                                                                                 | 把整个仓库（含 `.git`）放在 `work/` 内；插件检测到会警告                                                                                                                                         |
| R10 | traffic-record 未适配                                                | 全部请求和响应正文写进 `~/.pi/agent/records/traffic.db`                                                                                                                                                                                                                                                                                                                                                                                                                 | 尽快落地 P3；之前在加密会话里禁用该扩展                                                                                                                                                          |
| R11 | 未声明契约的其他第三方扩展                                           | 它们自己的日志或缓存可能落盘                                                                                                                                                                                                                                                                                                                                                                                                                                            | `status` 会列出这些扩展；按需在加密会话里关闭                                                                                                                                                    |
| R12 | web-hub / LAN / 飞书机器人（D1、Q2 已接受）                          | 会话内容以明文出现在网页和飞书里；挂载期间 preview 可读 vault。hub stateDir 里**以明文持久化**的内容包括：web 上传附件；飞书机器人收到的文件；session-history 快照（`spawn/fork-src`）；**飞书非终态 request 的正文 `payload.body`**（`hub/feishu/state.ts:130-168`）；**待发回复和卡片的 outbox content**（`state.ts:284-296,1109-1158`）；**managed spawn 的 stderr 日志** `<logDir>/<spawnId>.stderr.log`（`spawn/stderr-sink.ts:10-14`，每份 ≤256 KiB，最多 20 份） | 不在 web 或飞书发送敏感附件和正文；需要时临时 `/webhub stop`；定期清理 hub stateDir（`~/.pi/agent/web-hub/`）；备份时排除该目录                                                                  |
| R13 | hub restore / relaunch 遇到卸载后重新挂载                            | 目录身份（dev/ino）变化导致恢复失败；未挂载时 web spawn 失败，报普通目录错误                                                                                                                                                                                                                                                                                                                                                                                            | 先 `pi-secure unlock`，失败的会话从 web 新开一个                                                                                                                                                 |
| R14 | `pi-secure run` 被 SIGKILL，或绕过启动器                             | 挂载留着不卸                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `pi-secure lock <name>`                                                                                                                                                                          |
| R15 | 控制面文件                                                           | `~/.pi/agent` 下的 settings、auth、trust、models、quota、telemetry 和默认会话空目录名不加密（不含会话正文）；另含 `cache-provider-evidence.json`（provider/model/时间戳/布尔）、`cache-ttl-measurements.json`、设置锁文件 `.pi-subagent.json.lock`（空文件）                                                                                                                                                                                                            | 无需处理；知悉即可                                                                                                                                                                               |
| R16 | 终端与 tmux 回滚、页缓存、同 uid 的 `/proc/<pid>/mem`                | init 时打印的 master key 和会话显示内容都留在这些地方                                                                                                                                                                                                                                                                                                                                                                                                                   | init 后执行 `clear` 并 `tmux clear-history`；同 uid 进程在威胁模型之外                                                                                                                           |
| R17 | 迁入 vault 之前的旧明文                                              | 原项目目录、git 对象、旧会话、备份仍是明文；SSD/CoW 上删除不等于擦除                                                                                                                                                                                                                                                                                                                                                                                                    | 迁移后删除原件并更新备份；高敏感数据应从一开始就放进 vault                                                                                                                                       |
| R18 | 模型 provider、web_search 后端                                       | 必然看到明文（用户已知）                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                |
| R19 | 卸载 helper 陷入不可中断状态                                         | `finalize` 到期后对其发 KILL 并放弃等待；进程可能还挂在后台，挂载状态不确定                                                                                                                                                                                                                                                                                                                                                                                             | 稍后执行 `pi-secure status` 和 `pi-secure lock <name>`；必要时手动 `fusermount3 -uz`                                                                                                             |
| R20 | 私有模式软边界：同 uid `/proc/<pid>/root`、`/proc/<pid>/cwd`         | 同 uid **有意的**进程可读到私有挂载中的明文——私有模式只防无意识访问，不防定向恶意进程（conformance NC9 永远输出 KNOWN，真机验收 J 节照实演示）                                                                                                                                                                                                                                                                                                                          | 唯一硬边界：独立系统用户运行 pi-secure（可选加固见 README）；`/proc` `hidepid=`/`yama` 仅作参考、未实测                                                                                          |
| R21 | `setns` 加入外层 userns + mntns（userns owner 规则）                 | 同 uid 进程可用 `nsenter -t <P1> -U -m --preserve-credentials` 加入命名空间读到明文                                                                                                                                                                                                                                                                                                                                                                                     | 同 R20（独立系统用户）                                                                                                                                                                           |
| R22 | `/proc/<pid>/{maps,mountinfo}`、`/proc/locks` 信息面                 | 暴露「存在私有挂载」这一事实与 cipher/租约路径（只读、不授终止权）                                                                                                                                                                                                                                                                                                                                                                                                      | 知悉即可                                                                                                                                                                                         |
| R23 | 私有实例孤儿窗口 / ns id 复用 / 额外 ns 引用                         | 监督者全部丢失时明文持续存在于 ns 直到 `lock`；有进程持有该 ns 的 fd 或 nsfs bind mount 时 ns 不随成员退出销毁（挂载不拆）；ns id 被内核复用给无关 ns 时判定偏向「仍有成员」——fail-closed 的误报（`status` 显示 ns-in-use/unverified 与 pid）                                                                                                                                                                                                                           | `pi-secure status` / `lock <name>`；额外引用用 `/sys/fs/fuse/connections` 排查；ns id 复用由 bootId+starttime+双 ns id 规避                                                                      |
| R24 | 被困守护（ns 内首次启动的常驻进程）                                  | ns 内启动的 tmux server、gpg-agent、ssh ControlMaster、语言服务器、dev server 等在收尾时被终止（从外部 attach 到 ns 内 tmux 的会话也随之结束；外部启动的 tmux server 不受影响，收尾文案区分）；stderr 列出被终止的进程                                                                                                                                                                                                                                                  | 不在私有会话里启动常驻服务                                                                                                                                                                       |
| R25 | 旧 hub 的版本替换循环                                                | 旧 hub 不认 `agent.nospawn.v1` 时仍可能反复替换 ns 内 agent 的版本观察（新 agent / 新 hub 都已处理；仅「新 agent + 旧 hub」组合存在）                                                                                                                                                                                                                                                                                                                                   | 在普通会话里 `/webhub restart` 升级 hub（hub 侧改动需重启 hub 进程）                                                                                                                             |
| R26 | 转换后的旧明文：备份、旧会话、旧 memory（细化 R17）                  | convert 从不删除源数据：原目录作为只读备份留在同级，旧会话与旧 memory 原样保留并在输出里逐条列出；删除由用户执行，SSD/CoW 上删除不等于擦除                                                                                                                                                                                                                                                                                                                              | 解锁核对保险库内容后删除备份（`status` 的 `backup:` 行给出命令）与列出的旧会话、旧 memory；高敏感数据应从一开始就放进 vault                                                                      |
| R27 | 导出包的元数据                                                       | 包里除密文外还有 MANIFEST 的 `origRealWork`（导出端的绝对路径）以及密文结构（文件个数、大小、层级、mtime）；拿到包的人可以离线暴力破解口令（W8）                                                                                                                                                                                                                                                                                                                        | 包按密文目录同等敏感对待（0600、妥善保管、用完删除）；使用强口令                                                                                                                                 |
| R28 | 会话复制的边界                                                       | 会话正文里出现的旧路径不改写；未发现的历史会话目录、其他项目里 `parentSession` 指向本项目的会话（反向链接）不处理；consult fork 缓存、web-hub `spawn/fork-src` 快照只列出、不复制                                                                                                                                                                                                                                                                                       | 用 `--sessions-from <目录>` 补充会话来源；按完成输出的清单手工清理旧位置                                                                                                                         |
| R29 | `--lazy` 后的既有访问                                                | 已打开的 fd、cwd 在挂载内的进程、运行中的作业可继续访问明文直到会话结束；插件在下一次输入/工具调用时拒绝（LOCKED）；FUSE 中断后页缓存仍可被已打开文件读到                                                                                                                                                                                                                                                                                                               | `--kill` 真正结束访问                                                                                                                                                                            |
| R30 | 转换期间 `.txn` 里的明文元数据                                       | `.txn/convert-<名字>.modes`（相对路径与原 mode），以及 `.base` / `.hashes`（相对路径、大小、mtime、内容 sha256）在库外以明文保存，完成或回滚后删除；暴露面不超出同目录下的明文备份                                                                                                                                                                                                                                                                                      | 知悉即可；中断的转换尽快 `--resume` 或 `--abort` 收尾                                                                                                                                            |
| R32 | 跨机器导入后的绝对路径                                               | 迁址只改写会话头、子会话引用、memory slug 与项目 sessionDir；项目内写死的绝对路径、指向旧位置的符号链接、IDE 与脚本配置都不修正                                                                                                                                                                                                                                                                                                                                         | 导入后手工更新                                                                                                                                                                                   |
| R33 | 读回校验不证明介质完好                                               | convert 的逐文件读回校验经过页缓存，证明的是加密/解密路径与内容一致，不证明数据已正确落在介质上                                                                                                                                                                                                                                                                                                                                                                         | 这正是备份不自动删除的原因：在解锁核对、必要时重新挂载（或重启）再核对之后，再删除备份                                                                                                           |
| R34 | 私有模式 gocryptfs 消息进 syslog                                     | gocryptfs 以 `-fg -notifypid=<P1>` 运行时把输出转给 syslog（伴随一个 `logger` 子进程，随 gocryptfs 退出；收尾把它算作 gocryptfs 的一部分、不先杀）——挂载后 gocryptfs 的消息不上终端、进 syslog，与守护模式一致（N1 实测）                                                                                                                                                                                                                                               | 知悉；排查挂载问题看 `journalctl`（gocryptfs 相关日志）                                                                                                                                          |
| R35 | fail-closed 的误报（跨 mount ns 占用扫描 / 同 uid 非 dumpable 进程） | 普通 `lock` 的 cwd 占用扫描按路径字符串比对：私有 ns 里 cwd 路径相同的进程会被误判为全局挂载的占用者（76，N4 §4-3）；会话期间新启动的同 uid 非 dumpable 进程（新登录的 ssh 会话、setuid 辅助程序）会让释放时的 ns 扫描判「不完整」⇒ 记录保留、退出 75——两者都只损失可用性，方向安全                                                                                                                                                                                     | 占用误报改用 `lock --lazy`；扫描不完整等无关进程退出后 `pi-secure lock` 清理；均不危及数据                                                                                                       |
| R36 | 外部收尾的归属证明限制（nohup 类 pi / 被收养的后台作业）             | supervisor 死后：nohup/tmux 类不怕 SIGHUP 的 pi 存活 ⇒ `orphan-ns`，`lock --kill` 可终止有记录/ns 证明的成员并收尾（N4 e2e 钉住）；但 ppid 链已断（被 init 收养）的后台作业无法证明归属 ⇒ 只报告 `ns-in-use`/未证明 pid，`lock` 76，需人工 kill 后再 `lock`（「不可证明 ⇒ 只报告不杀」的保守取舍）                                                                                                                                                                      | nohup 类 pi：`pi-secure lock <name> --kill`；被收养作业：按 `status` 列出的 pid 人工核对后 kill，再 `lock`                                                                                       |

私有模式不改变 D1/R12（Q8 拍板）——§5 其余条目对私有会话同样成立。R26–R28/R30/R32/R33 来自 convert 方案（convert-plan §9；R31 已因 `RENAME_NOREPLACE` 消除）。

**转换相关说明**（不是明文残留，但影响使用与验收）：

1. **73 的文案**：等待 `mount.lock` 超时（10 s）的提示仍然是「另一个 pi-secure 正在挂载或卸载（mount.lock 等待超时）」，但导出（`export`）全程同样持有 `mount.lock`，所以在导出期间 `unlock` / `run` / `lock` 得到的也是这句话。原因是启动器的 N0 off golden（`tests/fixtures/secure-launcher-off-golden.json`）冻结了这条文案；export 自己等锁时用的是「正在挂载、卸载或导出」。看到 73 时，请同时考虑是否有导出在进行（`ps` 中的 `pi-secure export` / `__archive-work`）。
2. **超过 5 秒的暂停会触发重验**：convert 在第 12 步完成最终的备份复核后，如果到第 13 步（建链接）或第 14 步（提交）之前已过去超过 5 秒（单调时钟或墙钟任一超过，或墙钟回拨；常见于 Ctrl+Z、系统休眠、调试器、调度停顿），会先打印「距上次备份复核已超过 5 秒…重新复核备份」，再完整重跑一次占用扫描与基线比较。不一致 ⇒ 回滚 74（`--resume` 中 ⇒ 76，之后 `--abort`）。正常运行这两步之间只需毫秒，不会触发。检查与紧随其后的动作之间仍有毫秒级窗口无法消除；链接与提交本身另有 EEXIST 与比较后写入的守卫。
3. **测试缝需要 `PI_SECURE_TEST_SEAMS=1`**：启动器内有 8 个仅供测试的环境变量 `PI_SECURE_TEST_*`（`SCAN_DELAY_MS`、`WORKER_DELAY`、`FINALIZE_STALL_MS`、`MOUNT_VERIFY_FAIL`、`ARCHIVE_ORPHAN_PIDFILE`、`ARCHIVE_STALL_MS`、`CONVERT_FAIL_AT`、`CONVERT_STOP_AT`）。它们**只在同时设置 `PI_SECURE_TEST_SEAMS=1` 时生效**；单独设置任意一个都会被忽略，每条命令在 stderr 打一行警告。两者都设时，`convert` 在取锁和提示之前先打印「!!! 测试缝已启用…」。只要环境里有任一测试变量（含门控本身），`status` 就会多一行 `warn: 测试用环境变量已设置：…`。这个门控防的是误设或继承来的变量，不是针对同 uid 进程的安全凭证（同 uid 对抗不在承诺内，R16）。真实使用前请 unset。

---

## 6. 测试与验收（简化）

- **单测**（vitest）：
  - `helper.mjs`：用**真实**的 pi `parseArgs` 跑参数审查矩阵（`--fork`、`--session` 的路径和 id、`--session-dir`、`@file`、`--no-extensions`、`--export`、`--`）；mountinfo 解析（八进制转义、foreign、stale）；`/proc` cwd 扫描；swap/core 检测（fixture）。
  - `src/secure/*`：域判定矩阵（env、cwd、挂载状态）；与 helper 的配置解析 parity；`loadSettings` 覆盖（secure 时忽略用户设置，plain 时字节相同）；LOCKED 闸门；D2/D3/D4 的边界；session-driver 的 sessionDir；跨域 resume 和 switch 被取消；cron 拒绝。
  - `secure` 段缺失或关闭时的 golden（`tests/fixtures/secure-off-golden.json`，永不重生成）。
- **集成**（真 stack，用假挂载探测端口）：secure 域下，bash job 的**实际**日志和 JSON 文件、workflow journal、consult fork（含 remove 和 sweep 的根目录）、子会话文件都在 `<state>` 下；scheduler 没有启动。`hubSafeEnv`：secure 环境 → 清洗结果（`PI_SECURE_*` 全无，TMPDIR 和 ARMORY_MEMORY_ROOT 恢复或删除）；plain 环境保持不变；spawnHub 和 supervisor 的 childEnv 都用 spy 断言。`--no-session` 的 secure 会话不被锁。
- **启动器测试**（vitest 驱动 bash，gocryptfs 和 fusermount3 用假脚本）：init、unlock、lock、run 的正路径；口令连错 3 次；参数被拒时 pi 不会被启动（含 `--session-dir ""`）。**有界收尾**：注入扫描超预算、`mount.lock` 被长期持有、假 fusermount 忽略 TERM 或一直 sleep 三种情况，断言 `lock` 和 `run` 的收尾都 ≤11s 返回，并给出对应告警；`unlock` 返回后，`flock -n mount.lock` 能立即拿到锁（锁 fd 没有泄漏给守护进程）。
- **Conformance**（自门控：gocryptfs/fusermount3/FUSE 可用即跑，缺失 skip；P0 已落地，在 pi peer 升级或 gocryptfs 升级前运行）：
  - C1 `-init` 和挂载经 TTY 提示口令（用 `script(1)` 伪终端）；
  - C2 带 `-nonempty` 能挂上哨兵目录，卸载后 `mkdir -p mnt/state/x` 报 ENOTDIR；
  - C3 卸载不需要额外的写权限，cwd 在挂载内时报 EBUSY；
  - C4 `dist/cli/args.js` 的 `parseArgs` 结果结构没有变化；
  - C5 `--session-dir` 下 `--fork`、`--name` 都写在 sessionDir 内。
- **真机验收**（tmux）：
  1. `init` → `run` → 金丝雀串 `CANARY-<uuid>` 依次经过 read/edit/write、bash（含后台 job）、子 agent、workflow、consult、memory → 退出并自动卸载。
  2. 执行 `grep -rFa CANARY ~/.pi /tmp /var/tmp ~/.local/share/pi-toolkit-secure/*/mnt`，**期望零命中**。这只是最终状态检查，**不能证明**运行期间没写过明文。
  3. 可选：用 `strace -f -e trace=%file`（**只记路径，不记读写缓冲**）配合假数据 vault 和假口令，trace 输出到 0700 目录，查看是否有 vault 外的创建或写入。
  4. 另验：由加密会话拉起 hub 后，在 web 上新开一个**普通目录**会话，应正常可用、不被锁；`pi-secure run acme --no-session -p "hi"` 正常返回；子目录直接执行 `pi` 时会话被锁；普通会话读 vault 被阻断；worktree 被拒绝；`lock` 在 EBUSY 时提示占用进程。

---

## 7. 分包与估时（目标 3–4 天）

| 包                    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 文件域                                                                      | 依赖                                                     | 估时  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- | ----- |
| **P0** 实测           | 用户先 `sudo apt install gocryptfs`；跑 C1–C5 探针，回填 §1                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/conformance/secure-gocryptfs.test.ts`、`scripts/dev/secure-probe.sh` | —                                                        | 0.5d  |
| **P1** 启动器         | `src/secure/bin/{pi-secure,helper.mjs}`（init/unlock/lock/status/run，参数审查，有界 `finalize`，幂等 sessionDir 补写，swap/core/traffic-record 检测）及其测试；冒烟：从 git 安装路径、经 `~/.local/bin` 符号链接都能运行                                                                                                                                                                                                                                                                     | `src/secure/bin/*`、`tests/secure/launcher*.test.ts`                        | P0                                                       | 1.5d  |
| **P2** 插件守护       | `src/secure/{domain,config,guards,command,env}.ts`；`src/index.ts` 在 178 行前调用 `initSecureDomain`、secure 下跳过 1433 行的 scheduler、完成装配；`src/config/settings.ts` 的 `loadSettings` 覆盖（克隆）；`session-driver.ts:858/885`；consult 根目录（`fork-store.ts:78,808`、`stack.ts:3056-3076`）；`worktree.ts` 的 H2 拒绝；cron 入口拒绝；`--no-session` 免检；`hubSafeEnv` 接入 `web-hub/agent/launcher.ts:106` 与 `web-hub/hub/spawn/supervisor.ts:1875`；`/secure status`；golden | 如左                                                                        | P0（与 P1 并行；共享的只有配置解析，靠 parity 测试约束） | 1.5d  |
| **P3** traffic-record | 每次捕获前检查 `PI_SECURE_SESSION`；`package.json` 声明 `piSecure`；补测试                                                                                                                                                                                                                                                                                                                                                                                                                    | `~/ai/pi-traffic-record/src/{index,capture}.ts`、`package.json`             | —                                                        | 0.25d |
| **P4** 文档与验收     | AGENTS.md 增加 `src/secure/` 小节；用户指南 `docs/dev/data-encryption/README.md`（init、迁移已有项目、残留清单）；真机验收                                                                                                                                                                                                                                                                                                                                                                    | 文档                                                                        | P1、P2、P3                                               | 0.5d  |

```
P0 ─┬─► P1 ─┐
    └─► P2 ─┼─► P4
P3 ─────────┘
```

合计约 **4.25 人日**（P0 0.5 + P1 1.5 + P2 1.5 + P3 0.25 + P4 0.5）。比 3–4 天的目标多 0.25 天，多出来的是 M1 的环境清洗和 M2 的有界收尾；不含评审返工和真机等待。若需压回 4 天，可把 P4 的真机验收与 P0 合并到同一次 tmux 会话里完成。车道按 dev-flow L2：每包返回后立即派 verifier，验收模型与开发模型不同；P1 和 P2 额外做一轮安全向的 review。

---

## 8. 撤下或否决的方案

| 方案                                                                    | 原因                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| r1：插件在会话中途翻转权限，加绊线，再 switchSession 迁移               | 扩展加载前就会写盘，且有权限窗口；已被复审否决                                   |
| r2：旁车租约 + flock 双锁 + hub 改走启动器 + crash 清洗 + swap 拒绝启动 | 超出务实版范围（约 12.5 人日），复审又指出旁车会自己占住挂载、恢复协议也没有闭合 |
| 全局 `alias pi=pi-secure`                                               | 与 `pi install` 等命令冲突，且对普通目录并不透明（复审 #10）                     |
| worktree 放行到 vault 内                                                | git common-dir 可能在库外（复审 #9），维持 D2 拒绝                               |
| 工具级 AES、加密版 SessionManager                                       | 没有可用钩子，bash/grep 也无法透明（explore.md）                                 |

---

## §R2 复审处置（r2 复审：1 Blocker / 9 Major / 3 Minor）

| #   | 严重度  | 摘要                                                                        | r3 处置                                                                                                                                                                             | 落点         |
| --- | ------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Blocker | `pi-secure` 先按 cwd 分域再审参数，导致 `--fork <vault>`、`@file` 走普通 pi | **修复**：`run <name>` 显式指定域，启动器永不 exec 普通 pi；参数审查复用 pi 的 `parseArgs`，覆盖 fork/session/session-dir/@file/no-extensions/export/no-session                     | §2.2.1、C4   |
| 2   | Major   | before_switch 覆盖不全，`/import` 源路径不可见                              | **部分修复**：resume 和 switch 取消跨域目标；new/fork/tree 沿用 vault 的 sessionDir；**`/import` 来源降级为残留**                                                                   | §2.5、R5、R7 |
| 3   | Major   | 域判定与 settings 覆盖的时序                                                | **修复**：activate 最开始用 env 加 `process.cwd()` 加挂载状态冻结域（只读原始 `secure` 段），两个设置入口都经过 `loadSettings` 覆盖；session_start 再核验，不符就 LOCKED            | §2.4         |
| 4   | Major   | 旁车占住挂载和标准流                                                        | **修复（删除旁车）**：`run` 以子进程方式运行 pi，退出时先 `cd /` 再尽力卸载，命令自身不留在挂载内                                                                                   | §2.5         |
| 5   | Major   | 冷启动入口和 cwd 没有闭合                                                   | **修复**：`pi-secure run <name> [-C 子目录]` 可在任意目录调用，先挂载再 cd 再启动 pi，所以 `process.cwd()` 在 vault 内；不承诺「cd 进去就自动解锁」；措辞改为「链接目标是普通文件」 | §2.1、§2.2   |
| 6   | Major   | hub 只在 forkInto 走启动器，太晚；restore 跨重新挂载                        | **降级为残留（务实版 hub 不改）**：已挂载时 web spawn 依靠项目 sessionDir 正常工作；卸载后的 restore 和 relaunch 可能失败                                                           | R13          |
| 7   | Major   | crashes.json 事后清洗不是预防                                               | **降级为残留**：删除清洗承诺，如实披露                                                                                                                                              | R1           |
| 8   | Major   | 管道 core_pattern 不受 RLIMIT_CORE 限制；zram writeback                     | **降级为残留（只警告）**：如实说明 apport 不受 ulimit 约束；zram 开了 writeback 或状态未知时也警告                                                                                  | R2、R3       |
| 9   | Major   | worktree 和 git common-dir                                                  | **修复**：维持 D2 拒绝，另在 common-dir 位于库外时警告                                                                                                                              | §2.5、R9     |
| 10  | Major   | 全局 alias 冲突                                                             | **修复**：不再推荐 alias，`pi-secure` 是独立命名空间                                                                                                                                | §0.3、§2.2   |
| 11  | Minor   | 旁车没有总截止                                                              | **修复（删除旁车）**：所有外部调用都加 `timeout` 或 `flock -w`，收尾总长 ≤约10s，有测试断言（r4 起由 §R3 M2 的统一 `finalize` 取代）                                                | §2.5、§6     |
| 12  | Minor   | strace 的 `%desc` 会记录读写缓冲                                            | **修复**：只用 `-e trace=%file`，配合假数据、假口令，输出到 0700 目录；明确为可选项                                                                                                 | §6           |
| 13  | Minor   | 共享库和发布接线                                                            | **修复**：脚本放在 `src/secure/bin/`，已在 npm `files` 内；不共享 lib，改用 parity 测试；P1 负责冒烟（git 安装路径、符号链接）；P2 不依赖 P1 产物                                   | §2.2、§7     |

---

## §R3 复审处置（r3 复审：0 Blocker / 2 Major / 2 Minor）

| #   | 严重度                       | 摘要                                                                                                                                                                                                                       | r4 处置                                                                                                                                                                                                               | 落点                                   |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| M1  | Major                        | 删掉 hub 环境清洗后，加密会话拉起的 hub 会让普通 web 会话被误判 secure 并 LOCKED，hub 临时路径也依赖 vault                                                                                                                 | **修复**：`hubSafeEnv` 删除 `PI_SECURE_*`，并按 `PI_SECURE_ORIG_ENV` 恢复或删除 `TMPDIR`、`ARMORY_MEMORY_ROOT`；接入 `spawnHub`（唯一出口）和 supervisor 的 childEnv（防御）；hub 协议不变                            | §2.4、§2.5 表、§2.7、§6                |
| M2  | Major                        | 「收尾 ≤10s」不成立：扫描无预算、`timeout` 只发 TERM、各段未计入统一截止                                                                                                                                                   | **修复**：统一的 `finalize(10s)`。扫描、`flock -w`、fusermount 都用剩余预算；到期对进程组发 KILL 且**不等待**（D 状态也不会卡住）；helper 有 `process.exit` 兜底；测试断言 ≤11s，覆盖三种卡死注入；D 状态残留列为 R19 | §2.5、§6、R19                          |
| m1  | Minor                        | 允许 `--no-session`，但 session_start 会因 sessionDir 为空而锁住会话                                                                                                                                                       | **修复（放行）**：非持久化会话免检会话文件和目录，仍检查 cwd 与挂载；验收加 `run --no-session -p`                                                                                                                     | §2.2.1、§2.4、§6                       |
| m2  | Minor                        | R12 漏列飞书 durable request 正文、outbox 回复和卡片、managed spawn 的 stderr                                                                                                                                              | **修复（披露）**：R12 补齐，并附源码坐标与缓解办法                                                                                                                                                                    | R12、§0.4 Q2                           |
| 附  | 复审「已核查项」中的实现提醒 | 已有 cron 不得被启动；consult 的 remove/sweep 必须同根；覆盖须克隆而不是改 `DEFAULT_SETTINGS`；`--session-dir ""` 按字段是否存在拒绝；mount.lock 的 fd 不得被守护进程继承；哨兵要核对类型、大小、属主、权限；R6 前提的措辞 | **全部采纳**                                                                                                                                                                                                          | §2.1、§2.2、§2.2.1、§2.4、§2.5、R6、§6 |

## §R4 复审处置（r4 复审：pass-with-changes，0 Blocker / 0 Major / 3 Minor）

| #   | 级别  | 问题                                                                                                     | 处置                                                                                                                                                                                                                                                                                    | 落点          |
| --- | ----- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| m1  | Minor | finalize 执行契约：卸载子进程需独立进程组、异步 IO；unref 不等于关管道；硬兜底 process.exit 返回码与告警 | **采纳（施工口径）**：卸载/扫描子进程 `detached:true` 独立进程组，超时 `kill(-pgid, SIGKILL)`；全异步 IO 并显式 `stdin/stdout/stderr` 置 ignore 或关闭；硬兜底以非 0 码（如 75）退出并 best-effort 向 stderr 写一行「卸载未完成，vault 仍挂载」。参照 src/git/run.ts 的进程组与截止写法 | §2.5 finalize |
| m2  | Minor | 迁移示例 `run acme -- --version` 与 `--` 边界冲突                                                        | **采纳**：示例改为 `run acme --version` 并注明 `--` 语义                                                                                                                                                                                                                                | §0.5 第7项④   |
| m3  | Minor | 「幂等补写」与「已有不同值只提示不覆盖」矛盾                                                             | **采纳**：不同值 ⇒ run/unlock 拒绝启动 + `init --fix-settings` 一键改写（先备份）                                                                                                                                                                                                       | §2.3          |

---

## §P0 回填（gocryptfs 1.8.0 实测，2026-10-23）

结论：**无设计级问题**；版本下限 ≥2.0 → **≥1.8**（已改 §2.2 init 行、§3 失败模式、文首环境说明）。逐条详见 `P0-report.md`。

| 项  | 结论                                                                                                                                                                                            | 受影响章节 / 施工口径                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1  | **通过**。TTY init/mount 口令提示、master key 单次打印、exit 12、mountinfo `fuse.gocryptfs`/source、`flock -o` 不泄漏锁均符合（不加 `-o` 会泄漏——`-o` 为必须）                                  | §2.2 init/unlock；§0.4 Q1                                                                          |
| C2  | **通过**。`-nonempty` 挂到哨兵目录；卸载后 `mkdir -p mnt/state/x` ENOTDIR、写 `mnt/work/y` 失败；无 `-nonempty` exit 10                                                                         | §2.1                                                                                               |
| C3  | **通过**。卸载不需挂载根写权限（0500 仍成功）；cwd 在挂载内报 busy；**挂载**时挂载点不可写会失败（exit 19）                                                                                     | §2.5（`mnt/` 须保持 0700 可写）                                                                    |
| C4  | **通过**，并补充发现：`--session-dir ""` 字段存在（空串）而 pi `main.js` 视为未设置；**末尾悬空的 `--session-dir`/`--fork`/`--session` 不被消费，落入 `unknownFlags`**；`--` 之后全部是 message | §2.2.1：审查须 **同时拒绝 `unknownFlags` 含 `session-dir`/`fork`/`session`**，pi 版本变动时先跑 C4 |
| C5  | **通过**。真实 pi（`--no-extensions`、`-p`、空凭据 ⇒ "No API key"，零模型请求）下，`--session-dir`+`--fork`+`--name` 只写 sessionDir（含 parentSession、name），`--no-session` 不写任何会话     | §1 事实行 3/4；§2.2.1                                                                              |
| 增  | **init 不得加 `-q`**（否则不打印 master key，违反 Q1）；unlock 可用 `-q`（口令提示仍在）。1.8 守护化为 `-fg -notifypid` 子进程，启动器不要依赖进程名匹配（可用 mountinfo 判活）                 | §2.2 init / unlock                                                                                 |
| 增  | 卸载统一用 `fusermount3 -u`（`/usr/bin/fusermount` 是其符号链接）；陈旧挂载（ENOTCONN）可被它清理，与 §3 一致                                                                                   | §3                                                                                                 |
| 增  | conformance 为「工具可用即跑」自门控（不再需要 `PI_TOOLKIT_GOCRYPTFS_CONFORMANCE=1`），gocryptfs/FUSE 缺失则 skip                                                                               | §6                                                                                                 |

---

## 修订记录：traffic 已并入 pi-toolkit（traffic-merge T7，2026-10-23）

- pi-traffic-record 已作为 `src/traffic/` 并入 pi-toolkit（设置组 `traffic.*`，`traffic.enabled` 默认 false；设计与拍板见 `docs/dev/traffic-merge/plan.md` r3）。对加密会话是**双保险**：
  - **设置层**：`applySecureDomainOverrides`（`src/config/settings.ts`，两个设置加载入口的共同出口）在 secure/locked 分支强制 `traffic: { …, enabled: false }`（T3 落地，两个入口各有一条测试）；toolkit 自身 `package.json` 也声明了与外部 v0.2.1 同形的 `"piSecure": { "honors": "PI_SECURE_SESSION/1" }`。
  - **运行层**：traffic 的唯一落库闸口 `persist()` 在每次写库前复查 `PI_SECURE_SESSION` / `getSecureDomain()`（不保留跨 await 的连接引用），engine 生命周期的各判定点（命令入口、钩子入口、票据铸造、fetch wrapper、流捕获每批、重放切点）同样复查，命中即停录并关库。
  - 因此 R10「traffic-record 未适配 ⇒ 明文落库」对**内置** traffic 不再成立。
- **D5 / §2.6 的外部包适配说明保留**：settings packages 里仍装着外部 pi-traffic-record 时，launcher 与 `/secure status` 的 D5 检测照旧——未声明 `piSecure` 的旧版本（< v0.2.1）依旧被警告；声明了的 v0.2.1+ 遵守 `PI_SECURE_SESSION`。toolkit 的认领协议（`Symbol.for("pi-traffic-record:claim")` / `external-active` + session_start `getCommands()` 复核）保证任何加载顺序下活动录制器恰为 1：外部实际在跑 ⇒ toolkit 让位，不会双写。从外部包迁移到内置 traffic 的步骤见 README「流量录制 / 从独立 pi-traffic-record 迁移」。
