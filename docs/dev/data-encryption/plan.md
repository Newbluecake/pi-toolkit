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

1. **项目要搬进保险库**。项目改放在 `~/secure/<name>/`。这是一个符号链接，指向 `<dir>/mnt/work`，`<dir>` 默认是 `~/.local/share/pi-toolkit-secure/<name>`。
   一个保险库可以放一个或多个项目（`work/` 下的子目录）。
2. **未挂载时进不去**。卸载后 `~/secure/<name>` 指向一个普通文件，`cd` 和打开都会失败，IDE 里已打开的窗口也会报错。先执行 `pi-secure unlock <name>`，或直接用 `pi-secure run <name>`。
3. **项目内的相对路径不变，绝对路径会变**：
   - `src/a.ts`、`../lib` 这类相对引用都照常工作。
   - 旧绝对路径（例如 `~/ai/acme/...`）全部失效。IDE 工作区、shell 脚本、cron、systemd unit、docker-compose 的 bind mount、`.env` 里的绝对路径都要更新。
   - pi 和 git 看到的是**物理路径** `~/.local/share/pi-toolkit-secure/<name>/mnt/work/...`，会话 header、web-hub 卡片和日志里显示的也是它；只有 shell 的 `$PWD` 仍是 `~/secure/<name>`。
4. **git 仓库要整体放入**（含 `.git`），不能只搬工作区。linked worktree，或 `.git` 指向保险库外的仓库，commit 的对象会写到外面（R9）。远端 push 照常进行，按设计就是明文上传。
5. **其他进程看不到保险库**。没有 `allow_other` 时，只有你本人（同 uid）能访问挂载：root、docker 守护进程、其他用户的服务都看不到。
   容器 bind mount 保险库目录会失败，需要改为在宿主机上运行，或改用其他方案。
6. **性能与文件系统差异**：
   - 大量小文件（如 `node_modules`）读写会明显变慢。
   - 硬链接只能在保险库内部建；指向保险库外的符号链接，其目标仍是明文。
   - 磁盘上的文件名和内容都加密，但文件个数、大小和目录层级可见。
7. **迁移已有项目**：
   - ① `pi-secure init acme`。
   - ② `pi-secure unlock acme`。
   - ③ `rsync -a ~/ai/acme/ ~/secure/acme/`（含 `.git`）。
   - ④ `pi-secure run acme --version`（不带 `--` 分隔；`--` 之后的内容按 pi parseArgs 会被当成消息）：每次 `unlock`/`run` 都会幂等补写 `.pi/settings.json` 的 `sessionDir`；项目自带的 `.pi/settings.json` 只合并这一个键，键值不同时会提示。
   - ⑤ 在保险库内执行 `git status` 和 `git rev-parse --git-common-dir`，确认位于 `~/secure/acme` 内。
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

### 2.1 目录布局（保留 r2 的哨兵法，代价很低）

```
<dir>  默认 ~/.local/share/pi-toolkit-secure/<name>/   (0700)
 ├─ cipher/                gocryptfs.conf 和密文（0700）
 ├─ mnt/                   挂载点（0700）
 │   ├─ work   ← 未挂载时是 0 字节、0400 的普通文件（哨兵）
 │   └─ state  ← 同上
 └─ mount.lock             只用来串行化 mount/umount（flock -w，有超时）
挂载后：mnt/work/ = 项目根，mnt/state/ = toolkit 私有区（sessions/default、tmp、bash-jobs、workflows、consult、memory）
用户入口：~/secure/<name>  →  符号链接到  <dir>/mnt/work   （未挂载时链接**目标是普通文件**，cd 会失败，见 R6）
```

- 未挂载时，所有指向 `mnt/work/…` 或 `mnt/state/…` 的写入（包括 pi 的 `mkdirSync(sessionDir)`、`mkdir -p`、write 工具）都会因 ENOTDIR 失败，不依赖权限位，也不存在需要回滚的中间态。
- 挂载要加 `-nonempty`。挂载前在 `mount.lock` 内确认 `mnt/` 下**恰好**只有这两个哨兵：用 lstat 逐项核对是普通文件、0 字节、0400、属于本 uid。有多余条目或属性不符就拒绝并列出。
- 哨兵只保护 `work/` 和 `state/` 两个前缀；`mnt/` 下其他文件名不在保护范围内，本方案也不会用到它们。
- `init` 中途失败时，留下的布局会被 `status` 判为 `incomplete`，并给出恢复步骤（删除 `<dir>` 后重新 `init`）。

### 2.2 命令面

**启动器 `pi-secure`**（`src/secure/bin/pi-secure`，bash；`src/secure/bin/helper.mjs`，纯 Node、无依赖）。它不劫持 `pi` 这个名字，也不会自动透传成普通的 pi。
安装方式：`/secure status` 会打印 `ln -s <包路径>/src/secure/bin/pi-secure ~/.local/bin/pi-secure`，由用户自己执行。启动器用 `readlink -f "$0"` 定位 `helper.mjs`。

| 命令                                             | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-secure init <name> [--path ~/secure/<name>]` | 前置检查（gocryptfs ≥1.8、fusermount3、flock、Linux）→ 建立 §2.1 布局与符号链接 → `gocryptfs -init -- cipher`（终端提示两次口令，并打印 master key，Q1）→ 首次挂载 → 建 `work/`、`state/…`，并写 `work/.pi/settings.json` 的 `sessionDir`（§2.3）→ 卸载 → 提示清屏                                                                                                                                                                                           |
| `pi-secure unlock <name>`                        | 在 `flock -o -w 10 mount.lock` 下（`-o`：flock 在 exec 子命令前关闭锁 fd，gocryptfs 守护进程不会继承这把锁；P0 验证 unlock 返回后 lock 仍能拿到锁）：已挂载就直接返回；否则做哨兵校验，再 `gocryptfs -nonempty -- cipher mnt`。口令由 gocryptfs 自己从 TTY 读取，toolkit 不经手；exit 12 时最多试 3 次（D9）。之后核对 mountinfo（`fuse.gocryptfs`，source 是 cipher），再幂等补写 `work/.pi/settings.json` 的 `sessionDir`（§2.3）。顺带打印 swap/core 警告 |
| `pi-secure lock <name> [--lazy]`                 | 执行 §2.5 的「有界收尾」（统一 10 秒预算）：`cd /` → 占用扫描 → 加锁卸载（`--lazy` 时加 `-z`）。若 EBUSY、超时或预算耗尽，打印占用者和建议后返回，不会卡住                                                                                                                                                                                                                                                                                                   |
| `pi-secure status [<name>]`                      | 挂载状态、布局完整性、gocryptfs 版本、cwd 在挂载内的进程、swap/core 警告、traffic-record 适配情况（D5）                                                                                                                                                                                                                                                                                                                                                      |
| `pi-secure run <name> [-C <子目录>] [pi 参数…]`  | `unlock` → `cd <work>/<子目录>` → 参数审查（§2.2.1）→ `ulimit -c 0; umask 077` → 设置环境变量 `PI_SECURE_VAULT=<name>`、`PI_SECURE_SESSION=1` → **以子进程方式**运行 `pi --session-dir <state>/sessions/default "$@"` → pi 退出后执行 §2.5 的有界收尾 → 以 pi 的退出码退出                                                                                                                                                                                   |

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

`init`、`unlock`、`run` 都会**幂等**写入 `<work>/.pi/settings.json`：`{"sessionDir": "<绝对路径>/mnt/state/sessions/default"}`。文件已存在时只合并 `sessionDir` 一个键；已有不同的值时：`run`/`unlock` **拒绝启动**并提示（给出 `pi-secure init <name> --fix-settings` 一键改写为 vault 内路径，改写前备份原文件为 `settings.json.bak-<时间戳>`），避免 rsync 带入的旧 `sessionDir` 让会话写到库外。这样迁移项目时先复制还是先 init 都能收敛到同一结果（复审 r4 m3）。

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

---

## 3. 失败模式

| 场景                                                                | 行为                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| gocryptfs 未安装、版本低于 1.8、非 Linux、缺少 fusermount3 或 flock | `pi-secure` 报错，给出安装提示；插件把配置中的 vault 一律当作未挂载（cwd 命中即 LOCKED） |
| 哨兵校验失败、mountinfo 不符、布局不完整                            | 拒绝挂载，列出问题                                                                       |
| 口令连错 3 次                                                       | 退出码 77                                                                                |
| `mount.lock` 等待超时（10s 或 5s）                                  | 报「另一个 pi-secure 正在挂载或卸载」，退出                                              |
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

| #   | 路径                                                      | 影响（一句话）                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 用户可采取的缓解                                                                                                                                                                                 |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | crashes.json                                              | pi 崩溃时把 error.message 和 stack 原样写进 `~/.pi/agent/crashes.json`，可能含会话片段                                                                                                                                                                                                                                                                                                                                                                                  | 崩溃后检查并删除相关记录；备份时排除该文件                                                                                                                                                       |
| R2  | swap / hibernate                                          | 内存页（含口令、明文）可能换出到未加密的 swap                                                                                                                                                                                                                                                                                                                                                                                                                           | 用加密 swap 或 zram（且不开 writeback），或关闭 swap；`pi-secure status` 会提示                                                                                                                  |
| R3  | core dump / apport                                        | 管道型 core_pattern（本机是 apport）不受 `ulimit -c 0` 限制，崩溃转储可能落进 `/var/crash`                                                                                                                                                                                                                                                                                                                                                                              | 关闭 apport（`sudo systemctl disable --now apport`），或把 `kernel.core_pattern` 改为非管道并保持 `ulimit -c 0`；`status` 会提示                                                                 |
| R4  | pi 原生 `/debug`、`/export <库外路径>`、`/share`、`/copy` | `/debug` 把全部消息写进 `~/.pi/agent/pi-debug.log`；其余三项分别写出、上传 gist、进剪贴板                                                                                                                                                                                                                                                                                                                                                                               | 加密会话里不要用这些命令；用过 `/debug` 后删除 `pi-debug.log`；`/export` 不带参数（默认写到 cwd，在 vault 内）                                                                                   |
| R5  | 普通会话里 `/import <vault 会话>`                         | pi 只给扩展暴露目标路径，会把 vault 会话完整复制进明文目录                                                                                                                                                                                                                                                                                                                                                                                                              | 不要从普通会话导入 vault 会话；导入一律在 `pi-secure run` 里做                                                                                                                                   |
| R6  | 绕过 `pi-secure` 直接用 `pi`                              | 已挂载时，在子目录里执行 `pi --fork/--session <vault 文件>` 或带 `@vault/文件`，会在扩展加载前（或作为普通会话的初始消息）写出明文；未挂载时无法 `cd` 进入 vault                                                                                                                                                                                                                                                                                                        | 一律用 `pi-secure run`。只有在已挂载、位于项目根目录、项目 `.pi/settings.json` 的 `sessionDir` 仍在，且没有被 `--session-dir` 或 `PI_CODING_AGENT_SESSION_DIR` 覆盖时，直接 `pi` 才落在 vault 内 |
| R7  | 跨域 fork / import / 结果搬运                             | 把 vault 会话或文件内容通过任意途径（复制粘贴、`@file`、手动 cp）带进普通会话或普通目录                                                                                                                                                                                                                                                                                                                                                                                 | 只能靠操作习惯；D4 只拦工具层的直接读取                                                                                                                                                          |
| R8  | bash 写到外部                                             | `cat secret > /tmp/x`、`curl -d @file …`、脚本自身落盘，D3 只管 write/edit                                                                                                                                                                                                                                                                                                                                                                                              | 不让模型在加密会话里跑会外写的命令；需要的话审阅 bash 调用                                                                                                                                       |
| R9  | git common-dir 或远端                                     | 项目若是 linked worktree，或 `.git` 指向 vault 外，commit 的对象会写到外面；push 会上传                                                                                                                                                                                                                                                                                                                                                                                 | 把整个仓库（含 `.git`）放在 `work/` 内；插件检测到会警告                                                                                                                                         |
| R10 | traffic-record 未适配                                     | 全部请求和响应正文写进 `~/.pi/agent/records/traffic.db`                                                                                                                                                                                                                                                                                                                                                                                                                 | 尽快落地 P3；之前在加密会话里禁用该扩展                                                                                                                                                          |
| R11 | 未声明契约的其他第三方扩展                                | 它们自己的日志或缓存可能落盘                                                                                                                                                                                                                                                                                                                                                                                                                                            | `status` 会列出这些扩展；按需在加密会话里关闭                                                                                                                                                    |
| R12 | web-hub / LAN / 飞书机器人（D1、Q2 已接受）               | 会话内容以明文出现在网页和飞书里；挂载期间 preview 可读 vault。hub stateDir 里**以明文持久化**的内容包括：web 上传附件；飞书机器人收到的文件；session-history 快照（`spawn/fork-src`）；**飞书非终态 request 的正文 `payload.body`**（`hub/feishu/state.ts:130-168`）；**待发回复和卡片的 outbox content**（`state.ts:284-296,1109-1158`）；**managed spawn 的 stderr 日志** `<logDir>/<spawnId>.stderr.log`（`spawn/stderr-sink.ts:10-14`，每份 ≤256 KiB，最多 20 份） | 不在 web 或飞书发送敏感附件和正文；需要时临时 `/webhub stop`；定期清理 hub stateDir（`~/.pi/agent/web-hub/`）；备份时排除该目录                                                                  |
| R13 | hub restore / relaunch 遇到卸载后重新挂载                 | 目录身份（dev/ino）变化导致恢复失败；未挂载时 web spawn 失败，报普通目录错误                                                                                                                                                                                                                                                                                                                                                                                            | 先 `pi-secure unlock`，失败的会话从 web 新开一个                                                                                                                                                 |
| R14 | `pi-secure run` 被 SIGKILL，或绕过启动器                  | 挂载留着不卸                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `pi-secure lock <name>`                                                                                                                                                                          |
| R15 | 控制面文件                                                | `~/.pi/agent` 下的 settings、auth、trust、models、quota、telemetry 和默认会话空目录名不加密（不含会话正文）；另含 `cache-provider-evidence.json`（provider/model/时间戳/布尔）、`cache-ttl-measurements.json`、设置锁文件 `.pi-subagent.json.lock`（空文件）                                                                                                                                                                                                            | 无需处理；知悉即可                                                                                                                                                                               |
| R16 | 终端与 tmux 回滚、页缓存、同 uid 的 `/proc/<pid>/mem`     | init 时打印的 master key 和会话显示内容都留在这些地方                                                                                                                                                                                                                                                                                                                                                                                                                   | init 后执行 `clear` 并 `tmux clear-history`；同 uid 进程在威胁模型之外                                                                                                                           |
| R17 | 迁入 vault 之前的旧明文                                   | 原项目目录、git 对象、旧会话、备份仍是明文；SSD/CoW 上删除不等于擦除                                                                                                                                                                                                                                                                                                                                                                                                    | 迁移后删除原件并更新备份；高敏感数据应从一开始就放进 vault                                                                                                                                       |
| R18 | 模型 provider、web_search 后端                            | 必然看到明文（用户已知）                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                |
| R19 | 卸载 helper 陷入不可中断状态                              | `finalize` 到期后对其发 KILL 并放弃等待；进程可能还挂在后台，挂载状态不确定                                                                                                                                                                                                                                                                                                                                                                                             | 稍后执行 `pi-secure status` 和 `pi-secure lock <name>`；必要时手动 `fusermount3 -uz`                                                                                                             |

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
