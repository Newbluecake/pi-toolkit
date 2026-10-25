# `pi-secure convert / export / import` 实施方案 — r3

> 状态：r3（2026-10-23）。r1 评审（`/tmp/secure-convert-review-r1.json`）处置见「§R1 评审处置」；r2 复审（`/tmp/secure-convert-review-r2.json`：6 Blocker / 1 Major / 1 Minor）按 dev-flow 第三轮由主会话裁定、用户拍板，处置见文末「§R2 评审处置」。
> **r3 的核心变化（用户拍板 2026-10-23）**：convert **不自动删除任何东西**。原目录先在同级原子改名为只读备份 `<原名>.pi-secure-backup-<时间戳>`，从备份拷入保险库并校验，成功后原路径换成指向 `~/secure/<名字>/work` 的符号链接；备份由用户确认后自己删除。旧会话与旧 memory 也只复制不删。r2 的整个删除事务（WAL、delete-intent、删除恢复、退出码 79）随之移除。
> 用户已拍板的其他三项不变：A 原路径换成符号链接；B 迁移该项目的 pi 旧会话；C 密文包导出/导入（不做明文导出，不提供导入外部 gocryptfs 目录的接口）。布局按 [`private-plan.md`](./private-plan.md) §L（L0）：挂载点 `~/secure/<名字>/`，项目根 `~/secure/<名字>/work`。
> **r3.1 修订注（2026-10-24，V4 安全评审 B3 裁定）**：回滚与 `--abort` **不再删除新库**。凡本文写「删新库」「删除 `<dir>` 与 `<mnt>`」「随后被回滚删除」之处（§0、§1.4 第 2/3 步回滚列、§1.4 中断文案、§1.6 R-A、§5 worker 模型与 I-C8、§7.2-4、W1）一律改读为：确认卸载、租约空闲、身份一致、无占用后，把 `<dir>` 与 `<mnt>` 用 `RENAME_NOREPLACE` 改名为同级 `<名字>.aborted-<txid>`（不覆盖），输出路径并提示「内含本次拷贝的密文，核对后可自行删除」；只有本 txid 创建且仍为空的挂载点目录可在身份核对后 `rmdir`（与 V2 探针同口径的残留）。登记项照旧只撤销 `pending === "convert:<txid>"` 的本事务条目。其余 r3.1 修订（恢复授权绑定、`.modes` 严格校验、worker owner-death、`--resume` 复核、git 加固、占用不可读即拒绝、权限恢复不完整即报告不完整、memory 冲突/不完整即失败）见 [`V4-report.md`](./V4-report.md)「§安全评审与验收处置」。
> 并列文档：`private-plan.md` r3（两份共用 §6 退出码表与 §8 包顺序）、[`plan.md`](./plan.md) r4。本文只写方案，不改代码。

---

## 0. 一页结论

- **A `convert <明文目录> [<名字>]`**：只读预检（早拒绝）→ 确认 → 建库、挂载（口令都在这之前输完）→ **原目录同级原子改名为备份**（`mv -n -T`，内核 `RENAME_NOREPLACE`；失败即拒绝，从不退化为「拷贝+删除」）→ 备份整树只读 → **在备份上做权威预检**并取基线 → 从备份拷入 `~/secure/<名字>/work`，经挂载读回逐文件校验、`git fsck` → 复制会话与 memory → **持久化屏障**（对密文所在文件系统 `syncfs`）→ 复核备份基线未变 → 原路径建符号链接 → 清除登记项的 `pending`（**唯一提交点**）。
- **不删除任何源数据**：任何一步失败 ⇒ 只删本次新建的保险库（满足安全条件时）、把备份改回原名、恢复权限；备份里的数据从不被修改或删除。成功后打印备份路径、删除命令与 SSD 残留提示，`status` 持续列出仍存在的备份。
- **唯一可恢复中间态**：「备份已改名、新库未完成」。用 `.txn/convert-<名字>.json` 小状态文件记录，`pi-secure convert --resume <名字>` 只能「完成链接」（仅当拷贝、校验、屏障都已完成并落盘），`--abort <名字>` 只能「删新库 + 备份改回原名」；两者都不碰备份里的数据。`pending` 一旦清除就不再允许 `--abort`。
- **原路径不存在的窗口**：从改名到建链接（含拷贝与校验时长）原路径不存在；口令输入、确认、建库、挂载都在改名之前完成，窗口内不需要任何交互。
- **收窄清单全部拒绝**：树内/树根挂载点、任何 xattr/ACL/capability（`getfattr` 为前置）、setuid/setgid/sticky、他人 uid 或非主组 gid、逃出根的相对符号链接、树外硬链接、树外 git alternates/`core.worktree`/commondir、linked worktree。权威检查在**冻结后的备份**上执行，原目录上的检查只用于早拒绝。
- **B 会话/memory**：只读复制 + hash 校验；源会话不改名、不删；复制期间源被追加 ⇒ 重试，仍不一致就报告，源不受影响。复制后只改写副本的会话头 cwd 等引用。旧路径列出供手动删除。
- **C `export`/`import`**：最小 tar（ustar + 只承载 path/size/mtime 的 pax）；符号链接与硬链接写进 MANIFEST；**MANIFEST 中所有条目（含链接的 `path` 与 `of`）走与 tar 成员相同的路径白名单、预算与统一冲突校验，链接只在暂存目录内重建**；发布不覆盖；迁址是有状态事务。
- **退出码**：65（内容不合格）、74（拷贝/校验/IO 失败已回滚，或回滚未完成）；**79 删除**。全表 §6。
- **工作量**：约 8 人日，9 包（§8）。

### 0.1 布局迁移的影响（详见 private-plan §L）

- 原路径符号链接直接指向 `~/secure/<名字>/work`（登记项派生的 `work`，也是物理路径，一跳）。
- `--path` 指定挂载点位置（缺省 `~/secure/<名字>`）。
- 会话迁入 `~/secure/<名字>/state/sessions/default`，memory 迁入 `~/secure/<名字>/state/memory/<slug>`。
- convert/import 只创建新布局的库；旧布局库只能 export（§3.2），再 import 成新布局（private-plan Q-L0 已拍板）。

---

## 1. A：`pi-secure convert`

### 1.1 语法

```
pi-secure convert <明文目录> [<名字>] [--path <挂载点>] [--no-sessions] [--sessions-from <目录>]… [--private]
pi-secure convert --resume <名字>
pi-secure convert --abort  <名字>
```

- `<名字>` 缺省取 `basename(<明文目录>)` 小写化、非法字符换 `-`、截到 32 位，须匹配 `VAULT_NAME_RE`；最终归属在 settings 锁内裁决（§1.4 第 2 步）。
- `--no-sessions`：跳过会话复制。`--sessions-from <目录>`（可重复）：额外会话来源（§2.2）。
- `--private`：完成后登记 `private:true`；转换过程本身用普通挂载（源本就是明文）。依赖 private 方案 N2；未落地时 exit 2。
- 不提供任何自动确认参数；必须有 TTY（口令、确认、`gocryptfs -init` 打印 master key；沿用 init 的 stdout-TTY 检查）。
- `--resume`/`--abort`：处理中断的转换（§1.6）。

### 1.2 符号链接指向

原路径 → `~/secure/<名字>/work`（绝对路径，一跳）。锁定时目标是 0 字节哨兵文件，`cd`/打开报 ENOTDIR，不会写进底层；解锁时 `cd <原路径> && pi` 的物理 cwd 即 vault 的 work，插件判为 secure，项目 sessionDir 生效。项目里写死的旧绝对路径在解锁期间照样能用。链接本身是明文区里的 symlink，名字与目标可见，内容不可见。

### 1.3 收窄规则（全部拒绝）

同一套规则执行两次：**早检**在原目录上、问口令之前（只为尽早拒绝，不作授权依据）；**权威检查**在冻结后的备份上（§1.4 第 6 步），结果以备份为准。

| 类           | 规则                                                                                                                                                                                       | 码      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 路径         | `realpath(源)` 是目录；源路径本身不是符号链接；严格位于 `$HOME` 之下（非 `$HOME` 及其祖先）；不在 `$HOME/.*` 之下；不在任何已登记库的 `dir`/`mnt` 之内、也不包含它们；不包含 pi agent 目录 | 65      |
| 系统目录     | 落在 `/etc /usr /bin /sbin /lib* /boot /dev /proc /sys /run /var /opt /srv /snap /tmp` 下（双保险）                                                                                        | 65      |
| 挂载点       | `/proc/self/mountinfo` 中任一挂载点（含同文件系统 bind、文件 bind、overlay）等于源根或位于其内（字面与 realpath 两种写法都比）                                                             | 65      |
| 父目录       | 本用户所有、可写、不是组/其他可写；父目录所在文件系统类型 ∈ {ext4, xfs, btrfs, f2fs, tmpfs}（确保 `RENAME_NOREPLACE` 由内核原子实现，§1.5）                                                | 65      |
| 属主/组/类型 | 任一条目 uid ≠ 本用户或 gid ≠ 本用户主组；出现 FIFO、socket、设备；不可读文件、不可进入目录——逐条列出（最多 20 条）                                                                        | 65      |
| 特殊位       | 任一条目带 setuid/setgid/sticky                                                                                                                                                            | 65      |
| 扩展属性     | `getfattr -R -h -d -m - --absolute-names`（worker，有截止）发现任何 xattr，含 `system.posix_acl_*`、`security.capability`、`user.*` ⇒ 拒绝并列出。`getfattr`（attr 包）缺失 ⇒ 69           | 65 / 69 |
| 外部硬链接   | 普通文件 `nlink` 大于其在树内出现次数                                                                                                                                                      | 65      |
| 符号链接     | 只读链接文本、从不跟随；按原位置词法解析：相对链接逃出根 ⇒ 拒绝；树内相对/绝对允许；指向树外的绝对链接允许但警告「目标仍是明文」                                                           | 65      |
| git          | 见 §1.3.1                                                                                                                                                                                  | 65      |
| 占用         | 同 uid 进程的 `cwd`、`exe`、任一 fd（`/proc/*/fd/*` + `fdinfo`）、`/proc/*/maps` 映射落在树内 ⇒ 列出 pid/comm；扫描超时或超上限 ⇒ 视为不确定，拒绝                                         | 76 / 75 |
| 并发         | 全局转换锁 `~/.local/share/pi-toolkit-secure/.convert.lock`（`flock -n`）已被持有                                                                                                          | 73      |
| 空间         | vault 所在文件系统可用空间 < 估算 ×1.10 + 64 MiB，或 inode 不足；拷贝中 ENOSPC ⇒ 74 回滚                                                                                                   | 74      |
| 前置         | gocryptfs/fusermount3/flock/getfattr/`mv`（coreutils，支持 `-n -T`）/`sync -f` 齐全；树内有 `.git` 时 git 可用；TTY                                                                        | 69 / 2  |

#### 1.3.1 git 规则（只读、最小环境）

所有 git 调用：剥离全部 `GIT_*`，`GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`、`-c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks`，经 worker、进程组 KILL、单条 ≤30 s（fsck 按大小放宽，§5）。权威检查时备份已只读，git 无法写它。

- 每个 `.git` 文件的 `gitdir:` 解析到树外 ⇒ 拒绝。
- `rev-parse --show-toplevel` ≠ 根、`--git-common-dir` 在树外、配置了 `core.worktree` ⇒ 拒绝。
- `.git/objects/info/alternates`（含嵌套仓库）指向树外 ⇒ 拒绝。
- `git worktree list --porcelain` 按记录（空行分隔）计数，多于 1 条 ⇒ 拒绝并提示 `git worktree remove`/`prune`。
- 未出生 HEAD：比较 `rev-parse -q --verify HEAD` 的退出码与输出。

### 1.4 流程

| #   | 步骤                                                                                                                                                                                                                                                                                                                                                                                          | 失败时                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0   | 取转换锁；早检 §1.3（原目录）；打印计划（源、条目数、字节、vault 路径、备份将使用的名字、会话与 memory 数、原路径不存在窗口说明、残留提示）；**确认**：键入保险库名                                                                                                                                                                                                                           | 无副作用，exit 1「已取消，未做任何修改」                            |
| 1   | 生成 `txid`；写状态文件 `.txn/convert-<名字>.json`（`phase:"claimed"`，§1.6）                                                                                                                                                                                                                                                                                                                 | 写失败 ⇒ 无副作用，74                                               |
| 2   | **名字认领**：`registerVault(name, {dir?, mnt?}, {expectAbsent:true, pending:"convert:<txid>"})`（settings 锁内复核，已登记 78，锁忙 73）→ `createLayout`（`<dir>`、`<mnt>` 独占创建，记录 dev+ino）→ `gocryptfs -init`（TTY，master key 打印一次）→ `unlockVault(v, {postMount:false})`（口令第三次；convert 自己的挂载走 V0 内部入口，凭本 txid 豁免 `pending` 检查，其他任何入口仍被拒绝） | 回滚 R-A（§1.6：删新库、撤销本 txid 登记；此时还没有备份）          |
| 3   | **改名为备份**：备份名 `<父目录>/<base>.pi-secure-backup-<YYYYmmdd-HHMMSS>-<4 位随机>`。状态文件先记 `phase:"renaming"` 与备份名（fsync 文件与 `.txn/`）→ `mv -n -T -- <源> <备份>` → lstat 两端：源不存在 ∧ 备份 (dev, ino) 等于源原来的 (dev, ino) 才算成功；否则（含目标已存在时 `mv -n` 静默不动、EXDEV、EINVAL 等一切错误）⇒ 拒绝 → fsync 父目录 → 状态文件 `phase:"backed-up"`          | 失败 ⇒ 回滚 R-A（源从未被改动），exit 65/74                         |
| 4   | **只读**：先把每个条目的原 mode 写入 `.txn/convert-<名字>.modes`（0600，fsync；含相对路径，R30）→ 自底向上 `chmod a-w`（目录与文件）                                                                                                                                                                                                                                                          | 回滚 R-B                                                            |
| 5   | **冻结后复扫**：占用（cwd/exe/fd/fdinfo/maps）——任何指向备份树的进程 ⇒ 回滚；mountinfo 确认备份树内无挂载                                                                                                                                                                                                                                                                                     | 回滚 R-B                                                            |
| 6   | **权威检查**：在备份上完整执行 §1.3 的全部内容规则（挂载点、属主/组、类型、特殊位、xattr、外部硬链接、符号链接、git）；通过后 lstat 全树取**基线**（dev, ino, size, mtime, ctime, mode, nlink），写入状态目录                                                                                                                                                                                 | 回滚 R-B，exit 65                                                   |
| 7   | **拷贝**（§1.5，worker）：从备份读，写进 `<work>`，算 sha256                                                                                                                                                                                                                                                                                                                                  | 回滚 R-B                                                            |
| 8   | **校验**：经挂载读回逐项比对类型、mode、size、mtime、链接文本、硬链接组、内容哈希；有 `.git` 时比较两边 `rev-parse -q --verify HEAD` 与 `status --porcelain=v2`，并**强制**在 vault 副本上跑 `git fsck --connectivity-only --no-dangling`（超时按失败处理）                                                                                                                                   | 回滚 R-B                                                            |
| 9   | 项目 sessionDir：`syncProjectSettings(v, {fix:true})`；原有 `.pi/settings.json` 先备份为 `settings.json.bak-<ts>`（均在 vault 内）                                                                                                                                                                                                                                                            | 回滚 R-B                                                            |
| 10  | 会话与 memory **复制**（§2，worker），逐文件校验；源一律不动                                                                                                                                                                                                                                                                                                                                  | 回滚 R-B                                                            |
| 11  | **持久化屏障**（§1.5）：worker 执行 `sync -f <realCipher>`（对密文所在文件系统 `syncfs`），并对 `<dir>`、`<mnt>` 的父目录与 `.txn/` fsync；成功后状态文件 `phase:"synced"`（fsync）                                                                                                                                                                                                           | 屏障失败或超时 ⇒ 回滚 R-B                                           |
| 12  | **复核备份**：再扫占用；lstat 全树比对第 6 步基线（ctime 能发现「chmod 回去再写」）；任一不符 ⇒ 回滚                                                                                                                                                                                                                                                                                          | 回滚 R-B                                                            |
| 13  | **建链接**：`symlink(<work>, <原路径>)`。`EEXIST`（原路径在窗口内被重新创建）⇒ **不覆盖**：保留新库与备份，状态文件保持 `synced`，报告「原路径已被占用」，exit 76（清理该路径后 `--resume` 完成，或 `--abort`）→ fsync 父目录 → 状态文件 `phase:"linked"`                                                                                                                                     | 见左                                                                |
| 14  | **提交**：settings 锁内清除 `pending`（仅当仍为 `convert:<txid>`），同时写入 `origin:<原路径>` 与 `backup:<备份路径>`。这是**唯一提交点**：此前 unlock/run/export 一律因 `pending` 拒绝（§3.5），新库不可能被打开写入；此后不允许 `--abort`                                                                                                                                                   | 清除失败 ⇒ 状态文件保持 `linked`，exit 74，提示 `--resume` 完成提交 |
| 15  | 删除 `.txn/convert-<名字>.{json,modes}`；有界 `finalize` 卸载（占用时保持挂载，exit 0 并提示，与 `run` 收尾口径一致——这是统一表中明确的「成功但仍挂载」例外）；打印备份删除说明与残留提示（§1.7）；exit 0                                                                                                                                                                                     | —                                                                   |

中断：第 14 步之前的 SIGINT/SIGTERM/SIGHUP ⇒ 停止当前步骤，执行对应回滚，exit 130/143，文案说明实际结果（「已回滚：备份已改回原名并恢复权限，新库已删除」或「回滚未完成：<剩余项>；`pi-secure convert --abort <名字>`」）；第 14 步本身不响应中断（毫秒级）。

### 1.5 拷贝、改名与持久化（`src/secure/bin/tree.mjs`，worker 中执行）

| 对象     | 拷贝                                                    | 校验                      |
| -------- | ------------------------------------------------------- | ------------------------- |
| 普通文件 | 流式读写算 sha256；`O_WRONLY                            | O_CREAT                   | O_EXCL | O_NOFOLLOW`；写完 fsync；mode（已保证 ≤0o777）与 mtime/atime 恢复（毫秒精度） | 类型/mode/size/mtime 一致；经挂载读回的 sha256 一致 |
| 目录     | 先建 0700，子项完成后自底向上恢复原 mode 与 mtime       | 子项名集合完全相等        |
| 符号链接 | `readlink` 原样写入，不跟随；`lutimes`                  | 链接文本逐字节一致        |
| 硬链接   | 按 (dev, ino) 分组，首个正常拷贝，其余在挂载内 `link()` | 组成员集合与 `nlink` 一致 |
| 稀疏文件 | 展开写满（接受）                                        | 内容一致                  |

- 所有遍历用 `lstat`、`O_NOFOLLOW`，从不跟随符号链接。
- **改名不覆盖**：Node 没有 `renameat2`；用 coreutils `mv -n -T`。本机 coreutils 8.32 实测（strace）：`mv -n -T a b` 调用 `renameat2(…, RENAME_NOREPLACE)`，目标已存在时 `EEXIST` 但 **mv 仍以 0 退出**——所以成功与否一律以事后 lstat 两端的 (dev, ino) 判定，从不看退出码。父目录文件系统限定在原生支持 `RENAME_NOREPLACE` 的类型（§1.3），避免 gnulib 在 EINVAL 时退回「先查后改」的非原子模拟。XC8 钉住。
- **持久化屏障**：gocryptfs 1.8 不保证转发 `syncfs`，但它把每次写入同步落到后端密文文件（FUSE 默认无写回缓存，写请求返回时数据已交给后端文件系统）。因此屏障做在**后端**：拷贝中每个文件经挂载 fsync（gocryptfs 转为对密文文件 fsync），全部完成后对 `realCipher` 执行 `sync -f`（coreutils `syncfs`），一次性落盘该文件系统上的全部密文数据与目录项；会话与 memory 写在 `<state>`，同在该后端文件系统，一并覆盖。`.txn/` 与相关父目录单独 fsync。屏障失败、超时或结果未知 ⇒ 回滚（备份始终完好）。
- 断电分析：建链接前断电 ⇒ 备份仍在（改名本身已 fsync 父目录；即使改名未落盘，原名下仍是同一份数据），`--abort` 或 `--resume`（仅 `synced` 之后）收敛；建链接后断电 ⇒ 屏障已完成，新库数据已落盘，备份仍在。**不存在只剩唯一副本的窗口**：备份要等用户自己删除。
- 读回校验经过页缓存，证明的是加密/解密路径与内容一致，不证明介质；这正是保留备份、由用户在验证后自行删除的原因（R33）。

### 1.6 状态文件与 `--resume` / `--abort`

- 位置：`~/.local/share/pi-toolkit-secure/.txn/`（0700，先于任何 vault 目录存在）。`convert-<名字>.json`（0600）：`{v:1, txid, name, phase, origin, backup, ids:{originParent, backup, vaultDir, mnt}, createdAt}`，`phase ∈ claimed | renaming | backed-up | synced | linked`；`convert-<名字>.modes`（0600）：备份树各条目原 mode（含相对路径，R30）。每次写入 tmp + fsync + rename + fsync `.txn/`。
- `pi-secure status` 列出未完成的转换：`convert <名字>: interrupted (<phase>) · --resume|--abort`。
- 恢复只看**实际状态**：逐项 lstat 原路径、备份路径、vault 目录、挂载点，比对 dev+ino；阶段名只决定允许哪种动作。

**`--resume <名字>`（只做「完成链接」）**：要求 `phase ∈ {synced, linked}` 且登记项 `pending === "convert:<txid>"`（或 `linked` 且 pending 已清）。动作：复核备份基线（第 12 步）→ 原路径若不存在则 `symlink`（EEXIST ⇒ 76，同第 13 步）、若已是我们的链接则跳过 → 提交（第 14 步）→ 清理状态文件。`phase < synced` ⇒ 拒绝并提示 `--abort` 后重新转换（拷贝未完成或未落盘时不允许把原路径指过去）。

**`--abort <名字>`（只做「删新库 + 备份改回原名」）**：要求登记项仍带 `pending === "convert:<txid>"`（提交后一律拒绝：「转换已完成，不能撤销；备份仍在 <路径>」）。按逆序、每步先核对身份：

- **R-B**（有备份时）：
  1. 原路径若是我们建的符号链接（lstat 为 symlink、ino 与状态文件一致、目标等于 `<work>`）⇒ 删除；不是 ⇒ 不动。
  2. 按 `.modes` 恢复备份树的 mode（ctime 必然变化）。
  3. `mv -n -T -- <备份> <原路径>`，事后 lstat 判定：备份不存在 ∧ 原路径 (dev, ino) 等于备份 ⇒ 成功；原路径已被占用（`RENAME_NOREPLACE` 保证不会覆盖，包括空目录）⇒ 保留备份原样、报告路径。
  4. 执行 R-A。
- **R-A**（新库）：只有同时满足「已确认卸载（全局 mountinfo absent、租约空闲）∧ `<dir>`/`<mnt>` 的 dev+ino 与状态文件一致 ∧ 无占用」才删除 `<dir>` 与 `<mnt>`（新库里只有本次拷入的副本）；否则保留并报告。然后在 settings 锁内删除 `pending === "convert:<txid>"` 的本事务登记项。
- 全部完成 ⇒ 删除状态文件，打印「已回滚」（exit 1 或 130）；任何一步未完成 ⇒ 保留状态文件，打印剩余项（exit 74）。
- 回滚与 abort 从不修改或删除备份树里的任何文件内容；唯一的变更是恢复 mode 与改回原名。

### 1.7 完成后的输出

- 「原目录已改名为只读备份：<备份路径>。请在确认保险库内容无误后自行删除：`chmod -R u+w -- '<备份>' && rm -rf -- '<备份>'`。」
- 「SSD / CoW 文件系统上删除 ≠ 擦除：备份与旧会话的数据块可能仍可恢复（R17/R26）。」
- `pi-secure status`（库行明细）与 `/secure status` 在登记项带 `backup` 且该路径仍存在时显示 `backup: <路径> (still present)`；路径不存在时不显示（下次写登记项时清除该键）。
- 其他仍含该项目明文的位置：旧会话与旧 memory 目录（逐条列出）、git 远端、备份、`crashes.json`（R1）、`pi-debug.log`（R4）、traffic.db（R10）、web-hub stateDir（R12）；web-hub `spawn/fork-src/` 与 `<agentDir>/cache/consult-sessions/` 中属于该项目的文件逐条列出。
- 「插件按进程冻结域判定：已在运行的 pi 进程需要重启后才认得新的原路径登记（origin）。」
- 「session-nav 的子会话识别缓存与 web-hub 历史列表按预算增量更新，旧条目可能短时间仍可见。」

---

## 2. B：会话与 memory 复制（`src/secure/bin/sessions.mjs`）

### 2.1 pi 会话事实（pi 1.3.0）

| 事实                                                                                                                                        | 证据                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 默认会话目录 `<agentDir>/sessions/--<cwd 去掉开头 / 后把 / \ : 换成 ->--`（有损）                                                           | `dist/core/session-manager.js:290-295`                                                                 |
| 会话头读取：pi 在文件开头的发现窗口（至多 1 MiB）内跳过空行与无法解析的行，取第一条合法的 `type:"session"` 记录；`parentSession` 为绝对路径 | `session-manager.js` `readSessionHeader` 及 `:698-703,1243-1248,1399-1404`（实现镜像该规则，XC6 钉住） |
| pi 按路径逐次打开追加（`appendFileSync`），不长期持有 fd；文件被移走后会在原名重新创建                                                      | `session-manager.js:754-812`                                                                           |
| 打开 v1/v2 文件时 pi 就地迁移重写                                                                                                           | `session-manager.js:74-86`                                                                             |
| 自定义 sessionDir 下 `list`/`continueRecent`/`findById` 按会话头 cwd 精确过滤                                                               | `session-manager.js:437-443,1355-1356,1422-1423,1450-1456`                                             |
| `/resume-recent` 走 `SessionManager.list(ctx.cwd, sessionDir)`                                                                              | `src/session-nav/index.ts:107-133`                                                                     |
| 子会话落在子会话 cwd 对应的默认目录；第 2 行 `subagent:child`                                                                               | `src/runtime/session-driver.ts:56-76,857-870`；`src/extensions/worktree.ts:108`                        |
| 父会话的 `subagent:run` 条目（终态与非终态、同一 run 可有多条）`data.diag.sessionFile` 指向子会话                                           | `src/session-nav/provenance.ts:259,279-285,349-356`                                                    |
| 会话目录来源：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > 设置 `sessionDir`（全局或项目 `.pi/settings.json`）                         | plan §1                                                                                                |

### 2.2 发现与入选

1. **候选来源**：`<agentDir>/sessions/` 下名字等于 `slug(root)` 或以其子目录 slug 开头的目录（字面与 realpath 各算一次）；全局设置的 `sessionDir`；树内每一个 `.pi/settings.json` 的 `sessionDir`；当前 `PI_CODING_AGENT_SESSION_DIR`；每个 `--sessions-from <目录>`。`root` 取原路径（改名前的路径，会话头里记的就是它）。
2. **逐文件读取**：按 §2.1 的 pi 规则找会话头；状态三分 `complete`/`partial`/`invalid`。`invalid` 与无法判定的候选不复制、只报告。
3. **入选**：`resolve(header.cwd)` 按路径段落在源根子树内（字面或 realpath）。
4. **子会话闭包**：从入选会话的每条 `subagent:run` 条目出发，按 visited (dev, ino) 去重追踪 `diag.sessionFile`，预算 ≤2 000 个文件、≤512 MiB；超预算 ⇒ 标记 `partial`，照常复制已发现部分并列出未追完的引用（不删除任何东西，所以 partial 只影响报告）。
5. **不入选，只列出**：consult fork 缓存、web-hub `fork-src` 快照、其他项目里 `parentSession` 指向本项目的会话（R28）。
6. 子目录会话：`oldCwd = root/sub` ⇒ `newCwd = <realWork>/sub`，在 `pi-secure run <名字> -C sub` 时可见。

### 2.3 只读复制与校验

- 源会话**只读打开**，从不改名、修改或删除。
- 每个文件：读全文算 sha256 与 size → 生成改写后的副本写入 `<state>/sessions/default/<原文件名>`（tmp `O_EXCL|O_NOFOLLOW` 0600 + fsync + rename；目录项由 §1.5 的屏障落盘）→ **再次读源**比较 size 与 sha256：一致 ⇒ 完成；不一致（复制期间 pi 追加了内容）⇒ 用新内容重做，最多 3 次；仍不一致 ⇒ 保留最后一次一致读取的副本并报告「源会话在复制期间被写入，副本截至 <时间>」，或（从未得到一致读取时）不写副本只报告。源始终不受影响。
- 目标同名已存在：逐字节等于改写结果 ⇒ 跳过（可重入）；否则冲突 ⇒ 74 回滚。
- 改写只发生在副本上：会话头 `cwd`（树内会话）、`parentSession`（落在复制集内时）；同一 run 的**所有** `subagent:run` 条目中落在复制集内的 `data.diag.sessionFile`；其余行逐字节不变；不升级版本；恢复源的 mtime/atime（列表排序与 48 h 窗口不变）。
- 校验：读回副本，行数相同、未改写行逐字节相同、改写行除映射字段外深度相等。
- 旧会话目录与文件清单在完成输出里列出，供用户确认后手动删除（例如 `rm -- <文件>…`）。

### 2.4 web-hub 侧（无需改 hub）

| 对象                        | 转换后                                                                                                        | 处置      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| session-history             | 现场枚举 agent dir；旧会话仍在（未删），照常列出                                                              | 无        |
| `spawns.json` 托管记录      | relaunch：旧会话文件仍在、cwd 指向原路径 ⇒ 新 pi 经符号链接进入 vault，会话文件在库外 ⇒ LOCKED（fail closed） | 无        |
| `spawn/fork-src/` 快照      | 明文副本（R12）                                                                                               | §1.7 列出 |
| session-nav provenance 缓存 | 按预算增量回填                                                                                                | §1.7 提示 |

### 2.5 memory（只复制）

- 只取源根的**精确 slug**（字面与 realpath 各一次），不取前缀与子目录 slug（`toSlug` 有损，`src/memory/paths.ts:35-49`）。
- **歧义检查**：枚举该 slug 的其他解码（每个 `-` 可能原是 `/`，2^k 种，k ≤10；k >10 ⇒ 歧义）；任一其他解码对应真实存在的目录 ⇒ 跳过 memory 并报告。
- 复制到 `<state>/memory/<toSlug(<realWork>)>/`，只读源、逐文件 sha256 校验（同 §2.3 的复读规则）；slug 目录本身可以是用户信任的符号链接（解析一次），目录内文件级符号链接与非普通文件跳过并报告。
- 旧目录不动，列出路径供手动删除。

---

## 3. C：密文包导出 / 导入（`src/secure/bin/tar.mjs` + `archive.mjs`）

### 3.1 包格式 `pi-secure-vault/2`

```
pi-secure-vault/cipher/gocryptfs.conf
pi-secure-vault/cipher/gocryptfs.diriv
pi-secure-vault/cipher/<加密名…>        （只有目录与普通文件成员）
pi-secure-vault/MANIFEST.json            （最后一个成员）
```

- tar 方言最小化：ustar 头 + 每成员可选 `x` 扩展头，只承载 `path`/`size`/`mtime`；uid/gid 写 0，不写 xattr；**从不写链接成员**（类型 1/2）。
- gocryptfs 密文里的**符号链接**（目标文本为加密后的 base64url）与**硬链接**只在 MANIFEST 中编码：
  - 符号链接：`{path, type:"symlink", target_b64, mtime}`；目标文本字符集 `[A-Za-z0-9_=-]`、长度 ≤4096。
  - 硬链接组：内容只以组内首个路径作为普通文件成员写一次；MANIFEST 记 `{type:"hardlink", path, of:<首个路径>}`。
- 导出照抄密文条目的 mode 与 mtime（XC1）；任何密文条目 mode 超出 0o777 ⇒ 拒绝导出（65）；密文条目上的 xattr：`getfattr` 可用时检测到即拒绝（65），不可用时警告。导入从不设置 xattr。
- MANIFEST：`{format:"pi-secure-vault", v:2, name, exportedAt, gocryptfsVersion, origRealWork, entries:[…], totals}`；`origRealWork` = 导出端 `<realMnt>/work`（R27）。不含哨兵、`mount.lock`、`mount.lease`、`private.json`、`.txn`。
- 措辞：MANIFEST 提供**完整性**校验，不提供来源认证；本工具不提供导入外部 gocryptfs 目录的接口。

### 3.2 `pi-secure export <名字> <文件.tar>`

1. `resolveVault`（新、旧布局都可）；登记项带 `pending` 或 `relocate` ⇒ 76/78；输出文件系统空间 ≥ 密文 ×1.02 + 1 MiB（74）。
2. `flock -o -w 10 mount.lock node helper.mjs __export …` **全程**持锁：
   - 全局 mountinfo ≠ absent ⇒ 76（`stale` 同样拒绝）；租约忙或私有记录非 stale ⇒ 76。卸载 + 持锁 + 租约空闲 ⇒ 密文静止，无需快照。
   - 遍历 `cipher/`（worker，lstat，不跟随）：目录、普通文件、符号链接、硬链接组；其他类型 ⇒ 65。
   - 写 `<文件>.partial-<txid>`（`O_EXCL`，0600）→ fsync → `link(partial, 最终名)`（`EEXIST` ⇒ 78，不覆盖）→ unlink partial → fsync 父目录。
3. 有界：worker 进度 + 60 s 停滞看门狗（75）；SIGINT ⇒ 删除 partial，130。并发 `unlock`/`run` 等锁 10 s 后得到 73，文案统一为「另一个 pi-secure 正在挂载、卸载或导出 <名字>」。
4. 输出：「已导出 N 个文件 M 字节到 <文件>。该包与密文目录同样敏感：拿到它的人可以离线暴力破解口令，请使用强口令。」

### 3.3 `pi-secure import <文件.tar> <名字> [--path <挂载点>] [--verify-password]`

1. 名字合法；`registerVault(name, entry, {expectAbsent:true, pending:"import:<txid>"})` 在 settings 锁内认领（78/73）；`<文件>` 是本 uid 普通文件；空间 ≥ 包 ×1.05 + 64 MiB（74）。状态文件 `.txn/import-<名字>.json`（同 §1.6 的写法）。
2. 暂存目录 `<dir 的父目录>/.<名字>.import-<txid>`（0700，独占创建）；**暂存根**记为 `S`（打开为目录 fd，后续所有创建都相对它解析）。
3. **统一路径验证器 `checkPkgPath(p)`**——tar 成员路径、MANIFEST 每个条目的 `path`、硬链接的 `of` **全部**经过它：
   - 以 `pi-secure-vault/` 开头；去前缀后只能是 `cipher/…`（MANIFEST 自身另行识别）；无 `..`/`.`/空段/绝对路径/反斜杠/NUL；合法 UTF-8；`cipher/` 下每段只允许 `[A-Za-z0-9._=-]`；单段 ≤255 字节、总长 ≤4096、深度 ≤64。
4. **校验型读取**（worker，逐成员流式；任一异常 ⇒ 删除暂存、撤销本 txid 登记，65）：
   - 预算：成员与 MANIFEST 条目**合计** ≤1 000 000；MANIFEST ≤64 MiB；单个 pax 头 ≤64 KiB；数值字段为安全整数且 ≥0；`size` ≤ 剩余字节；`mtime` ∈ [0, 2^41]；累计处理字节 ≤ 包大小。
   - 头校验和正确；只接受类型 `0`/`\0`、`5`、`x`；`x` 只认 `path`/`size`/`mtime`，重复键或其他键 ⇒ 拒绝；ustar 头 size 可表示时必须等于 pax size。其余类型一律拒绝。
   - 写入：目录 0700、文件 `O_EXCL|O_NOFOLLOW` 0600，边写边算 sha256；mode/mtime 最后恢复；mode 超出 0o777 ⇒ 拒绝。
   - 包尾：MANIFEST 之后只允许零块与填充；截断即拒绝。
5. **MANIFEST 核对与链接重建**：
   - `v===2`；`origRealWork` 为规范化绝对路径、≤4096、以 `/work` 结尾；`gocryptfs.conf` 严格模式（`Version===2`、`EncryptedKey`/`ScryptObject` 字段类型与范围、`FeatureFlags` ⊆ {GCMIV128, HKDF, DirIV, EMENames, LongNames, Raw64}，未知键/flag 或 `PlaintextNames` ⇒ 拒绝；XC3 钉住）。
   - **统一冲突校验**：把 tar 成员（目录、文件）与 MANIFEST 链接条目放进同一张路径表：任何路径只能出现一次（不论类型）；任何条目的每个祖先路径必须是表中的**目录**条目（不能是文件或链接，也不能缺失）；链接条目的 `path` 不得已经存在于暂存树中；硬链接 `of` 必须是表中的普通文件条目、不得是链接或目录。MANIFEST 普通条目与实际成员的 size/sha256 一致，集合完全相等。
   - **只在暂存根内重建**：链接按路径深度升序创建；每次创建前对父目录逐段 `lstat`（相对 `S`），要求每段都是刚由读取器创建的目录（dev+ino 已登记）、不是符号链接；`symlink(target, S/<path>)`、`link(S/<of>, S/<path>)` 的两端都必须落在 `S` 之内（规范化后前缀校验 + 父目录身份校验）；`EEXIST` 即拒绝，从不覆盖。
   - 重建完成后再遍历一次暂存树：条目集合等于路径表，类型一致。
6. **发布**（每步写状态文件）：在暂存内建 `mount.lock`、`mount.lease`；`mkdir(<dir>, 0700)` 独占创建并记录 dev+ino；把暂存各顶层条目 `rename` 进这个自建空目录（身份不符或 `ENOTEMPTY` ⇒ 中止）；删除已空的暂存目录；`mkdir(<mnt>, 0700)` 独占创建（已存在 ⇒ 78）并写两个哨兵；`checkLayout(unmounted)`；`sync -f <dir>` 落盘。
7. 登记：路径与 `origRealWork` 不同时写 `relocate:{from:origRealWork, to:<realWork>, txid, phase:"pending"}`（§3.4）；清除 `pending`（仅本 txid）——导入的提交点。
8. `--verify-password`（需要 TTY）：进入 §3.4 的受控迁址路径。口令连错 3 次 ⇒ 77，导入结果保留（文案：「包已导入并校验；口令未验证；迁址仍待完成：`pi-secure init <名字> --fix-settings`」）。
9. 结果：成功 0；提交前失败 ⇒ 撤销已发布目录（身份一致时）与本 txid 登记，74；导入已提交但迁址失败 ⇒ exit 1，文案「导入完成；迁址未完成：`pi-secure init <名字> --fix-settings` 继续」（`relocate` 标记保证此前 run/export 被拒）。

恢复表（`status` 显示，`pi-secure import --abort <名字>` 执行；提交后不可 abort）：

| 实际状态                                           | 动作                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| 仅暂存存在                                         | 删除暂存，撤销本 txid 登记                                  |
| `<dir>` 是本 txid 建的（ino 一致）且部分条目已移入 | 整体撤销                                                    |
| 已发布、登记仍带 `pending:"import:<txid>"`         | 撤销，或重新执行第 7 步完成登记（`import --resume <名字>`） |
| 已登记、带 `relocate`                              | 交给 §3.4                                                   |

### 3.4 迁址事务

- 登记项 `relocate:{from, to, txid, phase}` 存在期间：`run`/`unlock`/`run --private`/`export` 一律拒绝（78，「迁址未完成：`pi-secure init <名字> --fix-settings` 继续」）；`status` 显示 `relocate: pending (<phase>)`。
- 受控入口 `init <名字> --fix-settings` 与 `import --verify-password`：
  1. 挂载不做 postMount（V0 的 `unlockVault(v, {postMount:false})`）；私有库在 private 方案的 setup 模式内执行，函数与 uid 无关。
  2. 改写 `state/sessions/default/*.jsonl`：会话头 cwd 中以 `from` 开头（按路径段对齐）的部分替换为 `to`；`parentSession` 与所有 `subagent:run` 的 `diag.sessionFile` 中旧 `<from 的 mnt>/state/sessions/default` 前缀替换为新路径。逐文件 tmp + rename，可重入。每批后更新 `phase`。
  3. `state/memory/` 中精确等于 `toSlug(from)` 的目录改名为 `toSlug(to)`（目标已存在 ⇒ 不合并，报告）。
  4. 最后改写 `work/.pi/settings.json` 的 sessionDir（`syncProjectSettings(fix)`）。
  5. `sync -f <realCipher>` 后在 settings 锁内清除 `relocate`（仅本 txid）。
     任一步崩溃：标记仍在 ⇒ 下次入口从实际状态继续。

### 3.5 与正在运行的会话、`--private` 的交互

| 场景                                                                                       | 结果                                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 已挂载 / 私有实例运行中 / 租约忙 ⇒ `export`                                                | 76                                                                           |
| 导出期间 ⇒ `unlock`/`run`/`run --private`/`lock`                                           | 等 `mount.lock` 10 s 后 73                                                   |
| 登记项带 `pending`（convert/import 进行中或中断）⇒ `unlock`/`run`/`run --private`/`export` | 76「保险库 <名字> 有未完成的转换/导入（<txid>）：`pi-secure convert --resume | --abort <名字>`」；`lock` 例外：确有挂载时允许卸载（不碰状态文件） |
| `import`                                                                                   | 只针对新名字                                                                 |
| `convert` 源位于某个库之内                                                                 | 早检 65                                                                      |
| 同名并发 init/import/convert                                                               | settings 锁内 `expectAbsent` 只让一个成功，其余 78                           |

---

## 4. 插件侧

| 点                                    | 结论                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 原路径符号链接上的域判定              | 无需改：物理 cwd 命中 vault 的 `mntReal`（private-plan §L.2）                                                                            |
| D4 路径类工具经原路径访问             | 无需改：`canonicalPath` 经符号链接解析进 `mntReal`；补一条单测                                                                           |
| D4 bash 命令文本（`cat ~/ai/acme/x`） | 登记 `origin`，`vaultSpellings` 加入 origin 的字面/`~`/realpath 三种写法；无 origin ⇒ 输出不变；域与拼写表按进程冻结，已运行的 pi 需重启 |
| 备份目录                              | 备份是普通明文目录（原内容），不属于保险库，插件不拦截（与转换前的原目录同等暴露）；`/secure status` 在其仍存在时提示删除                |
| `pending`/`relocate`/`backup`         | `config.ts` 与 helper 两侧解析（缺省不输出该键，parity 追加）；带 `pending` 的库按 locked 判定                                           |
| 跨域 resume                           | 无需改：`assertSessionFileInDomain` 用 canonical 判定                                                                                    |
| session-nav / memory / web-hub        | 无需改（§2.4、§2.5）                                                                                                                     |

---

## 5. 有界性、并发与不变量

- **worker 模型**：遍历、getfattr、拷贝、读回校验、git、tar 读写、会话复制、`sync -f` 都在 `node helper.mjs __convert-work <op>` worker 中执行（独立进程组），每完成一个真实工作单元发一行 JSON 进度；**60 s 无进展** ⇒ TERM → +2 s KILL → +1 s 放弃等待（unref），该步骤记为「未知」⇒ 回滚。由于 r3 没有任何删除源数据的步骤，被放弃的 worker 迟到的 IO 只可能写进新库（随后被回滚删除或在 `--abort` 时删除），不会触及备份；回滚删除新库前仍要求「已卸载 ∧ 租约空闲 ∧ 无占用」，迟到的 worker 若仍持有挂载内的 fd 会被占用检查拦下，保留新库并报告。
- 退避等待期间监督者持有一个 ref'd 定时器；监督者从不在挂载路径上做同步 fs。
- 固定上限：占用扫描 5 s、单条 git 30 s（fsck：30 s + 每 GiB 60 s，上限 30 min）、`sync -f` 60 s 停滞、`finalize` 10 s + 0.5 s、`mount.lock` 10 s、settings 锁 10 s。与数据量成正比的步骤只受停滞看门狗约束；交互时间不在有界承诺内。
- **不变量**：
  - **I-C1** convert/import 从不删除、截断或修改任何源数据：原目录只被改名为备份并去掉写权限（失败时改回、恢复权限），旧会话与旧 memory 只读。备份由用户自行删除。
  - **I-C2** 唯一提交点是清除登记项的 `pending`（convert 第 14 步、import 第 7 步）；提交前新库不可被打开（`pending` 使 unlock/run/export 拒绝），失败一律回滚；提交后不允许 abort。
  - **I-C3** 拿不准就拒绝：扫描超时、git 超时、属主/组/类型/特殊位/xattr/挂载点异常、包成员或 MANIFEST 异常一律拒绝；内容规则以备份上的权威检查为准。
  - **I-C4** 有界性如上。
  - **I-C5** 并发：转换锁；settings 锁内 `expectAbsent` 认领名字；`mount.lock` 只在挂载/卸载/导出期间持有，不在持有它时调用会再取它的 `unlockVault`；租约保证同库至多一个 gocryptfs。
  - **I-C6** 改名一律 `RENAME_NOREPLACE`（`mv -n -T` + 事后身份判定），建链接一律 `symlink()`（`EEXIST` 不覆盖），导入只写暂存与自己独占创建的目录，链接只在暂存根内重建。
  - **I-C7** 口令只由 gocryptfs 从 TTY 读取；`import` 不需要口令（`--verify-password` 除外）；`export` 从不读口令。
  - **I-C8** 只删除本 txid 新建的保险库目录与登记项；在建链接（提交）之前，新库数据已经过持久化屏障。

---

## 6. 退出码（统一表，与 private-plan §10 相同）

| 码      | 含义                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | 成功（convert 成功但收尾时挂载被占用而保持挂载，同 `run` 口径，仍为 0 并提示）                                                                                              |
| 1       | 一般失败 / 用户取消（只有真的什么都没改时才说「未做任何修改」；回滚后说「已回滚」）；import 已提交但迁址未完成                                                              |
| 2       | 用法错误 / 需要 TTY                                                                                                                                                         |
| 64      | pi 参数被拒；私有库不带 `--global` 的 `unlock`                                                                                                                              |
| 65      | 源目录或包内容不合格（路径、挂载点、属主/组、特殊位、xattr、特殊文件、外部硬链接、逃逸符号链接、git 结构、改名失败、恶意或损坏的 tar、MANIFEST 不符、密文 mode 超出 0o777） |
| 66      | 未找到保险库 / 文件                                                                                                                                                         |
| 69      | 前置缺失（userns；convert 的 `getfattr`、git、`mv -n -T`、`sync -f`）                                                                                                       |
| 73      | 锁忙（`mount.lock`、settings 锁、转换锁）；挂载/卸载/导出进行中（含私有实例 `starting`/`mounting`）                                                                         |
| 74      | 拷贝/校验/IO/持久化屏障失败、空间不足，已回滚；或回滚未完成（附剩余项）                                                                                                     |
| 75      | 预算耗尽 / 停滞看门狗 / 硬兜底                                                                                                                                              |
| 76      | 占用或状态冲突（已挂载、租约忙、私有实例运行中、源被占用、待完成的转换/导入、原路径在窗口内被重新占用）                                                                     |
| 77      | 口令连错 3 次（import 时导入结果保留）                                                                                                                                      |
| 78      | 配置错误（名字已登记、目录/挂载点已存在、sessionDir 冲突、旧布局、迁址未完成、目标文件已存在）                                                                              |
| 130/143 | 被中断，文案说明实际结果                                                                                                                                                    |

`run` 照旧透传 pi 的退出码。r2 的 79 删除：不自动删除之后，不存在「已提交但删除收尾未完成」的状态。

---

## 7. 测试与验收

### 7.1 单测（vitest，无 FUSE）

- `tests/secure/tree.test.ts`：普通文件、空目录、只读目录、符号链接（树内相对/树内绝对/树外绝对/逃逸相对/悬空）、硬链接组（树内/外部）、FIFO、socket、mode 000、特殊位、他人 gid（注入）、大文件；`mv -n -T` 改名的事后身份判定（目标已存在时 mv 退出 0 但未移动 ⇒ 判失败）；chmod 只读与按 `.modes` 恢复；基线比对发现 ctime 变化。
- `tests/secure/convert-preflight.test.ts`：路径规则；文件系统类型白名单；mountinfo 夹具（同 fs bind、文件 bind、overlay、八进制转义路径）；xattr 夹具（getfattr 输出注入）；git 规则（真 git 建 tmp 仓库：linked worktree、子模块、alternates 树外、`core.worktree`、commondir、未出生 HEAD、worktree 记录计数）；占用扫描（cwd/exe/fd/fdinfo/maps，超时即拒绝）；**权威检查以备份为准**：早检通过、改名后备份上出现 xattr/ACL/特殊位/他组文件 ⇒ 拒绝并回滚。
- `tests/secure/convert-state.test.ts`：状态文件各 `phase` × 实际状态（原路径/备份/新库/链接是否存在、身份是否一致）的 `--resume`/`--abort` 决策表；`pending` 已清 ⇒ abort 拒绝；`phase < synced` ⇒ resume 拒绝；abort 从不触碰备份文件内容（spy：对备份树只出现 chmod 与一次改名）；回滚时原路径被占用 ⇒ 保留备份、不覆盖。
- `tests/secure/sessions.test.ts`：pi 头规则镜像（空行、坏行、1 MiB 窗口）；complete/partial/invalid；树内多个 `.pi/settings.json` 的 sessionDir；`--sessions-from`；闭包预算；同一 run 多条 `subagent:run`；**源只读**（复制前后源的 dev/ino/size/mtime/内容不变）；复制期间追加（屏障：读完源、写副本之后向源追加）⇒ 重试成功或报告，源不变；memory 精确 slug 与歧义检查；用真 pi `SessionManager.list` 断言可见性；迁址前缀改写。
- `tests/secure/tar.test.ts`：往返（长路径、mode/mtime、MANIFEST 符号链接与硬链接组）；**恶意语料**（生成脚本入库）：穿越、绝对路径、链接成员、设备、FIFO、重复成员、全局 pax、未知/重复 pax 键、超大 pax 头、ustar/pax size 不一致、负数/超大数值、size 超剩余字节、深度/条目数超限、校验和错、截断、前缀外成员、非法字符、缺 MANIFEST、哈希不符、成员多/少、非 UTF-8、`PlaintextNames`/未知 FeatureFlag/未知 conf 键、符号链接目标非法、mode 超 0o777；**r3 新增（评审 B6）**：tar 成员全部合法，但 MANIFEST 链接 `path` 为 `../x`、绝对路径、含 `.`/空段/非法字符、与已有成员同名、与另一链接同名、祖先是文件或链接、祖先缺失、硬链接 `of` 穿越/指向链接/指向目录/指向不存在条目、链接条目使总数超预算——每条 65，**断言暂存根之外无任何新条目**（测试在暂存父目录放哨兵并比对前后快照）、零登记。
- `tests/secure/archive.test.ts`：导出拒绝矩阵（已挂载/stale/租约忙/私有/pending/relocate/目标已存在/空间）；`link()` 发布不覆盖；导入认领、发布到自建空目录、恢复表每行；`relocate` 崩溃后 run/export 拒绝。
- 同名竞态：init / import / convert 两两交错（屏障）⇒ 恰好一个成功，其余 78，失败方不删除胜者的任何东西。
- parity 追加：`origin`/`backup`/`pending`/`relocate` 合法/非法；guards：原路径 D4 用例。

### 7.2 启动器 e2e（真 gocryptfs，假 pi）——`tests/secure/launcher-convert.test.ts`

1. **convert 往返**：夹具含 git 仓库（多次提交、未跟踪、已修改、`.bin` 符号链接、硬链接组）、子目录、空目录、只读文件、长文件名；对照副本先行保存。完成后：原路径是指向 `~/secure/<名字>/work` 的符号链接；备份 `<原名>.pi-secure-backup-<ts>` 存在、只读、内容与对照逐项一致（mode 除外：已去写位）；锁定时 `cd` 原路径失败；解锁后 work 与对照逐项 diff 为零，**允许的差异仅有** `work/.pi/settings.json` 与其 `.bak-<ts>`；`git status`/`rev-parse` 一致、fsck 通过；`status` 显示 `backup: … (still present)`；`.txn` 文件已删除。
2. **会话**：根/子目录/父子 agent/worktree 子会话/无关会话；真 pi `list` 可见性；**旧会话文件全部原样保留**（字节与 mtime 不变）；完成输出列出旧路径。
3. **回滚**：测试缝 `PI_SECURE_TEST_CONVERT_FAIL_AT=<step>:<before|after>`（只能让流程失败）覆盖第 2–14 步每一步 ⇒ 原路径恢复为原目录，与对照逐项一致（含 mode），新库目录与登记都不存在；第 11 步屏障失败（测试缝让 `sync -f` 非零）⇒ 同样回滚。
4. **中断恢复**：在 `renaming`/`backed-up`/`synced`/`linked` 各阶段 kill -9 ⇒ `status` 显示中断；`--abort` 恢复原目录、删除新库；`synced`/`linked` 阶段 `--resume` 完成链接与提交；`backed-up` 阶段 `--resume` 拒绝；提交后 `--abort` 拒绝；回滚时新库仍挂载/被占用 ⇒ 保留并报告「回滚未完成」。
5. **备份被改动**：在第 12 步之前（屏障）对备份某文件 `chmod u+w` 后写入 ⇒ 基线复核失败 ⇒ 回滚，备份改回原名后包含该写入（数据不丢）。
6. **拒绝**：源被占用 ⇒ 76 无口令提示；树内 bind mount ⇒ 65；带 ACL/xattr ⇒ 65；setgid 目录 ⇒ 65；逃逸相对链接 ⇒ 65；alternates 树外 ⇒ 65；源在 `$HOME/.config` ⇒ 65；缺 getfattr ⇒ 69；备份名已被占用（预先建同名空目录）⇒ 改名判失败、65、源原样。
7. **原路径在窗口内被重新占用**：第 12、13 步之间建同名目录 ⇒ 不覆盖、76；删除该目录后 `--resume` 完成。
8. **export→import**：库内含符号链接与硬链接 ⇒ 往返后解锁内容一致；`tar -tf` 可列出；`--verify-password` 完成迁址；不带时 `run` ⇒ 78、`--fix-settings` 后正常；迁址中途崩溃 ⇒ run/export 拒绝、继续后完成；已挂载 export ⇒ 76；导出期间 unlock ⇒ 73；口令错 3 次 ⇒ 77 且导入保留。
9. 恶意语料逐个 import ⇒ 65，零残留、暂存根外零变更。

### 7.3 Conformance —— `tests/conformance/secure-convert.test.ts`

| #   | 钉住的事实                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XC1 | gocryptfs 1.8 把明文 mode/mtime 存为密文 mode/mtime                                                                                                                                            |
| XC2 | 冻结包格式 v2 之前的闸门：真 gocryptfs 对文件、目录、符号链接、硬链接、长文件名、xattr 的密文表示                                                                                              |
| XC3 | `gocryptfs.conf` 结构与 `init` 产生的 FeatureFlags 集合等于允许集                                                                                                                              |
| XC4 | 卸载 + 持锁 + 租约空闲时，导出前后密文树哈希相同                                                                                                                                               |
| XC5 | GNU tar 能 `-tf` 我们的包；GNU tar 生成的同内容包无 MANIFEST ⇒ 拒绝                                                                                                                            |
| XC6 | 真 pi：会话头读取规则；自定义 sessionDir 下按 cwd 精确过滤；`open` 迁移后的 v3 文件不重写                                                                                                      |
| XC7 | `getfattr -R -h -d -m -` 能报告 `system.posix_acl_access` 与 `security.capability`                                                                                                             |
| XC8 | coreutils `mv -n -T` 在白名单文件系统上使用 `renameat2(RENAME_NOREPLACE)`（strace 可用时断言系统调用；否则断言「目标为空目录时不被替换」的行为），且目标已存在时退出 0——实现必须以事后身份判定 |
| XC9 | gocryptfs 写入在 `write`/`close` 返回时已交给后端（未协商 FUSE 写回缓存）；`sync -f <cipher>` 对后端文件系统执行 `syncfs`                                                                      |

### 7.4 acceptance.md 新增节

- **K. convert**（在真实项目的**副本**上演练）：
  - [ ] 一次确认、口令三次（init 两次 + 挂载一次），master key 打印一次；口令与确认都在改名之前完成。
  - [ ] 转换期间另一个终端看原路径不存在、同级出现 `<原名>.pi-secure-backup-<ts>`（只读）。
  - [ ] 完成后原路径是符号链接；锁定时 `cd` 失败；解锁后 `cd <原路径> && pi` 状态栏 `secure`，物理路径 `~/secure/<名字>/work`。
  - [ ] 项目测试/构建、`git log`/`git status` 与转换前一致；唯一新增改动是 `.pi/settings.json`（及备份）。
  - [ ] 输出含备份删除命令与 SSD 提示；`pi-secure status` 显示备份仍存在；手工删除备份后不再显示。
  - [ ] 反例：shell 停在源目录 ⇒ 76；对 `$HOME` ⇒ 65；linked worktree ⇒ 65；树内 bind mount ⇒ 65；带 ACL ⇒ 65。
  - [ ] 拷贝中 Ctrl-C ⇒ 「已回滚」，原目录回到原名、权限恢复、内容与对照一致，新库不存在。
  - [ ] 拷贝中 `kill -9` ⇒ `status` 显示中断，`convert --abort` 恢复原状。
- **L. 会话复制**：
  - [ ] 源目录里聊几轮（含子 agent），子目录再开一个会话。
  - [ ] `pi-secure run acme` 的 `/resume` 能看到根会话、子 agent 会话被隐藏；`-C sub` 能看到子目录会话。
  - [ ] 旧会话与旧 memory 原样保留并被列出；手工删除后 `grep -rFa <金丝雀> ~/.pi/agent/sessions` 零命中。
- **M. export / import**：
  - [ ] `lock` 后 `export`；已挂载时 ⇒ 76。
  - [ ] 另一用户/机器 `import … --verify-password` ⇒ 内容一致、`/resume` 可见。
  - [ ] 不带 `--verify-password` ⇒ 首次 `run` 提示 `--fix-settings`，执行后正常。
  - [ ] 手工构造含 `../x` 成员、或 MANIFEST 链接 `path` 为 `../x` 的包 ⇒ 65，零残留。
  - [ ] 旧布局库能 `export`，再 `import` 为新布局。

### 7.5 冻结面

| #   | 冻结项                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 现有子命令在没有 `origin`/`backup`/`pending`/`relocate` 与 `.txn` 状态文件时，输出与退出码不变——复用 private N0 golden（L0 之后生成），不新建、不重生成 |
| G2  | 例外：USAGE 新增行（与 private Q9 同一处）；`unlock` 等 `mount.lock` 超时的 73 文案统一为「挂载、卸载或导出」（N0 生成前定稿）                          |
| G3  | `secure-off-golden.json`、三份 fabric off golden 不变；parity 除 L0 一次性修订外只追加                                                                  |
| G4  | 插件：无 origin 时 `vaultSpellings` 输出不变                                                                                                            |

---

## 8. 分包、顺序与冲突规避

### 8.1 分包

| 包                       | 内容                                                                                                                                                                                                                                                                                                                                    | 文件域                                                                                                 | 依赖                                                               | 估时       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------- |
| **V1** tar               | 最小 pax 写入器 + 带预算的校验型读取器 + MANIFEST（链接编码）+ 统一路径验证器与冲突表 + 暂存根内链接重建 + conf 严格校验 + 恶意语料（含 MANIFEST 链接语料）                                                                                                                                                                             | `src/secure/bin/tar.mjs`（新）、`tests/secure/tar.test.ts`、`tests/fixtures/secure-tar-corpus/gen.mjs` | —                                                                  | 1d         |
| **V2** tree              | 遍历、mountinfo/xattr/特殊位/组/链接/文件系统类型规则、空间估算、`mv -n -T` 改名与身份判定、chmod 只读与恢复、基线、拷贝、清单、比对、`sync -f` 屏障、worker 协议                                                                                                                                                                       | `src/secure/bin/tree.mjs`（新）、`tests/secure/tree.test.ts`                                           | —                                                                  | 1.25d      |
| **V3** sessions          | pi 头规则镜像、发现/入选/预算闭包、只读复制 + 复读校验、副本改写、memory 精确 slug 复制、迁址引擎                                                                                                                                                                                                                                       | `src/secure/bin/sessions.mjs`（新）、`tests/secure/sessions.test.ts`                                   | —                                                                  | 0.75d      |
| **V0** helper 最小 API   | `unlockVault(v, {postMount:false})`、类型化错误（锁忙 ⇒ 73 等）、`registerVault(name, entry, {expectAbsent, pending})` 与「仅本 txid」清除、`finalizeBounded`、`scanCwdOccupants`、`preflight`；V4/V5 以注入端口接收                                                                                                                    | `src/secure/bin/helper.mjs`、对应单测                                                                  | private **N2** 已合入                                              | 0.5d       |
| **V4** convert 编排      | `cmdConvert`：早检、确认、建库挂载、改名备份、只读、权威检查、拷贝校验、会话复制、屏障、复核、建链接、提交；状态文件；`--resume`/`--abort`                                                                                                                                                                                              | `src/secure/bin/convert.mjs`（新）、`tests/secure/{convert-preflight,convert-state}.test.ts`           | V2、V3（V0 端口可先用假实现）                                      | 1d         |
| **V5** archive           | `cmdExport`/`cmdImport`/迁址事务、恢复表、`import --resume                                                                                                                                                                                                                                                                              | --abort`                                                                                               | `src/secure/bin/archive.mjs`（新）、`tests/secure/archive.test.ts` | V1、V3；V0 | 1d  |
| **V6** 接线              | helper：`main` 分派 `convert`/`export`/`import`/`__export`/`__convert-work`、USAGE、`init --fix-settings` 迁址入口、`describeVault` 显示状态文件/pending/relocate/origin/backup、`resolveVault` 对 pending/relocate 的拒绝；`config.ts` 两侧解析 `origin`/`backup`/`pending`/`relocate` + parity 追加；`guards.ts` 拼写表；`command.ts` | `src/secure/bin/helper.mjs`、`src/secure/{config,guards,command}.ts`、parity fixture、对应测试         | V0、V4、V5                                                         | 0.75d      |
| **V7** e2e + conformance | §7.2、§7.3（XC2 在 V1 冻结格式前先跑，XC8/XC9 在 V2 开工前先跑）                                                                                                                                                                                                                                                                        | `tests/secure/launcher-convert.test.ts`、`tests/conformance/secure-convert.test.ts`                    | V6                                                                 | 1.25d      |
| **V8** 文档              | plan.md「转换与迁移」+ R26–R28/R30/R32/R33；acceptance K/L/M；README（取代 plan §0.5 第 7 项的手工迁移，写明备份由用户删除）；AGENTS.md 一句                                                                                                                                                                                            | 文档                                                                                                   | V7                                                                 | 0.5d       |

合计 **8 人日**（V0 0.5 + V1 1 + V2 1.25 + V3 0.75 + V4 1 + V5 1 + V6 0.75 + V7 1.25 + V8 0.5）。比 r2 少 1.25d：删除事务、WAL、CAS 删除与删除恢复整体移除。

### 8.2 统一顺序与冲突规避（两份方案共用）

```
L0 ─► N0 ─► N1 ─► N2 ─┬─► N4 ─► N5
 └──► N3 ─────────────┘
              N2 ─► V0 ─┐
V1 ───────────────────┬─┼─► V5 ─┐
V2 ─┬─────────────────┼─┴─► V4 ─┼─► V6 ─► V7 ─► V8
V3 ─┴─────────────────┘         │
                                 └（V4/V5 依赖 V0 端口；V1–V3 随时可开工）
```

- **helper.mjs**：L0 → N1 → N2 → V0 → V6 严格串行；V1–V5 全是新文件（零依赖 ESM，同目录相对 import），不碰 helper。
- **`parseSecureConfig`（两侧）**：L0 一次性改形状；N1 加 `private`；V6 加 `origin`/`backup`/`pending`/`relocate`。缺省不输出该键、非法用新 reason、parity 只追加且不改前序用例。
- **`registerVault`**：V0 统一为 `registerVault(name, entry, {expectAbsent, pending})`；N2 写 `private` 时若已改成条目补丁则直接复用，否则由 V0 改造并迁移 N2 的调用点。
- **`init --fix-settings`**：迁址只挂在 V0 的受控入口上，普通库与私有库（P1 setup 模式内）共用，与 uid 无关。
- **`describeVault`/`cmdStatus`**：N2 加私有分支，V6 只追加「有对应键/文件才输出」的行。
- **启动器 off golden**：L0 之后由 N0 生成，两份方案共用，永不重生成。
- private 方案被推迟时：V4/V5 的租约与私有实例检查退化为全局 mountinfo，V0 基于 L0 之后的 helper 实施。
- 车道 dev-flow L3；每包返回立即派 verifier（验收模型 ≠ 开发模型）；V1、V2、V4、V5 额外安全向 review（改名不覆盖与身份判定、回滚只碰本 txid、屏障、tar/MANIFEST 解析与暂存根内重建）。

---

## 9. 风险与残留

| #   | 风险                                                 | 概率/影响 | 对策                                                                       |
| --- | ---------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| W1  | 逻辑缺陷导致数据丢失                                 | 极低/高   | 不删除任何源数据；备份只改名与去写位；回滚只删本 txid 新库；全阶段故障注入 |
| W2  | 用户过早删除备份而新库有问题                         | 低/高     | 先持久化屏障再建链接；完成输出建议先解锁核对；`status` 持续提示备份存在    |
| W3  | 同 fs bind mount 混入树内                            | 低/中     | mountinfo 拒绝（早检 + 备份上的权威检查）                                  |
| W4  | 大目录耗时长，原路径不存在窗口随之变长               | 中/中     | 进度、看门狗；计划摘要写明窗口；建议先清理 `node_modules` 等               |
| W5  | 收窄规则拒绝了常见项目（ACL、setgid 目录、他组文件） | 中/低     | 逐条列出并给出 `setfacl -b`/`chmod g-s`/`chgrp` 建议                       |
| W6  | 备份占用双倍空间直到用户删除                         | 高/低     | 计划摘要与完成输出写明                                                     |
| W7  | tar/MANIFEST 解析器漏洞                              | 低/高     | 统一路径验证器 + 冲突表 + 暂存根内重建 + 预算 + 语料 + 安全 review         |
| W8  | 导出包被离线暴力破解                                 | 中/高     | 文案；0600；强口令                                                         |
| W9  | git index stat 缓存失效                              | 高/低     | 文档                                                                       |
| W10 | 有损 slug                                            | 中/低     | 会话按头 cwd；memory 精确 slug + 歧义跳过                                  |
| W11 | 与 private 方案的 helper 冲突                        | 中/中     | §8.2 串行规则                                                              |
| W12 | 未发现的历史会话目录                                 | 低/低     | `--sessions-from`；R28                                                     |
| W13 | 文件系统不在白名单（无法保证 `RENAME_NOREPLACE`）    | 低/低     | 拒绝（65）并说明                                                           |

**新增残留（并入 plan §5）**：R26 备份、旧会话、旧 memory 由用户删除，删除 ≠ 擦除（细化 R17）；R27 导出包含 `origRealWork` 与密文结构信息；R28 会话正文里的旧路径不改写，未知历史会话目录与其他项目指向本项目的反向链接不处理；R30 转换期间 `.txn/convert-<名字>.modes` 以明文保存相对路径（与备份同等暴露，完成或回滚后删除）；R32 跨机器导入后项目内写死的绝对路径与符号链接不修正；R33 读回校验经页缓存，不证明介质完好（备份由用户在核对后自行删除即为此）。r2 的 R31（回滚改名竞态）因改用 `RENAME_NOREPLACE` 消除。

---

## 10. 待决问题

**已拍板（用户 2026-10-23）**：convert 不自动删除任何东西（原目录改名为只读备份、用户自行删除）；旧会话与旧 memory 只复制不删；收窄清单全部拒绝、`getfattr` 为前置、权威检查在备份上执行；Q-L0 旧布局只读兼容（与 private-plan 同一项）。

**评审已同意，按推荐保留**：Q1 一跳链接（新布局下即 `~/secure/<名字>/work`）；Q3 登记 `origin`（尽力而为；已运行的 pi 需重启）；Q4 外部硬链接拒绝；Q6 convert 本身不进私有 ns；Q8 不提供自动确认参数，保留 init 的 stdout-TTY 检查；Q9 追踪树外子会话，按预算；Q10 不做 stdout 导出。r2 的 Q5（旧会话删除方式）、Q7（第二次确认被拒）、Q12（freeze-first 不可用窗口）、Q13（退出码 79）随「不自动删除」失去对象，删除。

**无剩余待决项。**

---

## 附：关键代码坐标

- 启动器复用点（V0 收口）：`src/secure/bin/helper.mjs`——`createLayout`、`registerVault`/`registerVaultUnlocked`（当前直接覆盖条目，V0 加 `expectAbsent`）、`resolveVault`、`checkLayout`、`unlockVault`/`doMount`/`postMount`（当前总是 postMount → `syncProjectSettings`）、`ensureVaultDirs`、`syncProjectSettings`、`writeFileAtomic`（只 fsync 文件后 rename，不 fsync 父目录——convert 不复用它做持久化，由 §1.5 的屏障负责）、`finalizeBounded`、`scanCwdOccupants`、`probeMountState`、`preflight`、`requireTty`、`EXIT`、`main`。
- pi：`dist/core/session-manager.js`（slug :290-295、头读取、追加 :754-812、cwd 过滤 :437-443、:1340-1460）。
- toolkit：`src/runtime/session-driver.ts:56-76,857-870`；`src/session-nav/provenance.ts`；`src/session-nav/index.ts:107-133`；`src/memory/paths.ts:25-49`；`src/git/worktrees.ts`（`parseWorktreePorcelain`）；`src/extensions/worktree.ts:108`；`src/secure/guards.ts:54-96`；`src/secure/domain.ts`；`src/web-hub/hub/spawn/{store,supervisor}.ts`。

---

## §R1 评审处置

来源：`/tmp/secure-convert-review-r1.json`（6 Blocker / 12 Major / 2 Minor / 1 Nit）。全部接受修复（Nit 部分采纳），无反驳项；多处以收窄功能代替保留风险。

| #   | 严重度  | 摘要                                                                                  | 处置                                                                                                                                                                                                                                                                                     | 落点                                    |
| --- | ------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Blocker | 源目录不静止：复核后仍可写入、mmap 写                                                 | 修复（收窄）：freeze-first——第一次确认后立即原子改名为隔离目录（原路径在整个转换期间不可用）、先记清单再整树 `a-w`、冻结后复扫占用（cwd/exe/fd/fdinfo/maps）、chmod 后取基线；第二次确认在冻结中进行；删除前逐条复核基线（ctime 捕获 chmod 回去）并再扫占用；屏障测试                    | §1.3、§1.4 第 3–5/11–12 步、§7.2-3、Q12 |
| 2   | Blocker | `st_dev` 漏掉同文件系统 bind mount，递归删除可能跨入他处                              | 修复：读 mountinfo，根或树内任何挂载点（含文件 bind、overlay，字面与 realpath）即拒绝；冻结时与删除开始时复查；删除器逐目录/文件核对清单 (dev, ino)，不一致/新挂载/符号链接替换即停，从不跟随链接                                                                                        | §1.3、§1.8、§7.1                        |
| 3   | Blocker | 日志不是持久 WAL，改名/建链/删除之间的崩溃窗口不可恢复                                | 修复：`.txn/<txid>.json` 位于 vault 目录之外（同时解决 createLayout 冲突）；每步「意图 fsync（文件+目录）→ 执行 → 观察」；记录各对象 dev+ino；恢复按实际状态；`delete-intent` 之后永不回滚；fsync 失败即不删；逐系统调用前后的故障注入                                                   | §1.6、§1.7、§7.1 txn                    |
| 4   | Blocker | 回滚可能在新库仍挂载/被占用时删除它                                                   | 修复：回滚删除新库需同时满足已卸载、租约空闲、目录 ino 一致、无占用、源已复原并校验；否则两边保留、报告「回滚未完成」；转换中登记项带 `pending`，unlock/run/export 拒绝；符号链接最后才建                                                                                                | §1.4、§1.7、§3.5                        |
| 5   | Blocker | 删除旧会话/memory 无 CAS                                                              | 修复：旧会话逐文件「改名 → 复核 stat 与哈希 → 删除」，不一致改回保留；事后检查原路径是否重新出现；memory 改为只复制不删除（Q2′）                                                                                                                                                         | §2.4、§2.6、Q2′                         |
| 6   | Blocker | 包只支持目录+文件，但 gocryptfs 密文含符号链接与硬链接                                | 修复：MANIFEST 编码符号链接（base64 目标，字符集与长度校验）与硬链接组（内容只存一次，导入时 `link()` 重建），tar 不含链接成员，遍历只用 lstat；XC2 作为冻结包格式前的闸门（含 xattr 表示）；密文 xattr 导出时检测；含 `.bin` 符号链接与硬链接组的往返测试                               | §3.1、§3.3-4、§7.2-7、XC2               |
| 7   | Major   | 改名再建链接非原子，空档可被 `mkdir -p` 填上                                          | 修复：承认两步（Node 无 RENAME_EXCHANGE，`mv --exchange` 需 coreutils ≥9.5，Ubuntu 22.04 更旧）；freeze-first 下原路径在整个转换期间本就不存在；最后用 `symlink()`，`EEXIST` 不覆盖、停在删除之前；回滚改名前显式检查 ENOENT；残留 R31                                                   | §1.4 第 13 步、§1.7、R31                |
| 8   | Major   | xattr/ACL/capability 丢失、gid 未保存、导入静默去特殊位                               | 修复（收窄）：`getfattr` 成为前置，任何 xattr 拒绝；特殊位拒绝；要求 uid 为本人、gid 为主组；导出与导入对 mode 超 0o777 一律拒绝（65）；稀疏展开接受；ENOSPC 回滚                                                                                                                        | §1.3、§3.1、§3.3、Q11                   |
| 9   | Major   | 名字认领竞态，`registerVaultUnlocked` 直接覆盖                                        | 修复：init/import/convert 统一 `registerVault(name, entry, {expectAbsent:true, pending})`，在 settings 锁内复核；只清除/撤销本 txid 的条目；锁忙映射 73；不在持有 `mount.lock` 时调用会再取它的 unlock；同名交错测试                                                                     | §1.4 第 2 步、§3.3、§5 I-C5/I-C8、§7.1  |
| 10  | Major   | 引用的 helper 导出不存在；`createLayout` 拒绝已存在目录；`unlockVault` 总是 postMount | 修复：新增 V0 包（private N2 之后）提供最小 API：`unlockVault(v,{postMount:false})`、类型化错误、registerVault 选项、`finalizeBounded` 等；V4/V5 以注入端口使用，先对假端口并行开发；日志移出 vault 目录                                                                                 | §1.6、§8.1 V0、§8.2                     |
| 11  | Major   | 相对符号链接语义改变（`../shared`）                                                   | 修复：按原位置词法解析，逃出根的相对链接拒绝（65）；树内相对与树内绝对允许；树外绝对允许并警告；跨机器导入不修正（R32）                                                                                                                                                                  | §1.3、R32                               |
| 12  | Major   | worktree 按行计数错误；漏 alternates；未出生 HEAD                                     | 修复：按 porcelain 记录计数；拒绝树外 alternates（含嵌套仓库）、`core.worktree`、树外 commondir；未出生 HEAD 比较 `rev-parse -q --verify` 退出码；vault 副本上强制 `git fsck --connectivity-only --no-dangling`（超时不删）；git 最小环境、禁 fsmonitor/hooks、无 optional locks；源只读 | §1.3.1、§1.4 第 8 步                    |
| 13  | Major   | memory slug 有损（`acme/sub` 与 `acme-sub`）                                          | 修复：只取根的精确 slug；枚举其他解码（≤2^10）发现真实目录即判歧义跳过；只复制；如实描述 slug 目录可为可信符号链接、文件级链接拒绝                                                                                                                                                       | §2.6                                    |
| 14  | Major   | 会话发现比 pi 窄（1 MiB 窗口跳坏行）；4 层闭包；子目录自定义 sessionDir               | 修复：镜像 pi 头读取规则（XC6 钉住）；complete/partial/invalid 三分；闭包按 visited (dev,ino) + 文件/字节预算，超预算 partial ⇒ 禁删旧会话；无法解析的候选保留；来源增加树内每个 `.pi/settings.json` 的 sessionDir 与 `--sessions-from`；残留 R28                                        | §2.1、§2.2、R28                         |
| 15  | Major   | 迁址入口：`--verify-password` 先撞 sessionDir 冲突；迁址中途崩溃后 run 能成功         | 修复：有状态迁址事务 `relocate:{from,to,txid,phase}`，存在期间 run/unlock/export 拒绝（78）；受控入口挂载不做 postMount → 改写会话与 memory → 最后改 sessionDir → 清 marker；可重入；崩溃测试                                                                                            | §3.4、§7.1、§7.2-7                      |
| 16  | Major   | tar 解析器缺预算                                                                      | 修复：成员、MANIFEST、深度、路径、pax 头、数值字段、size、mtime、累计字节全部设限；重复 pax 键拒绝；ustar/pax size 一致；`origRealWork` 模式校验；conf 严格模式 + FeatureFlags 允许集；措辞改为「完整性而非来源认证；不提供外部目录导入接口」                                            | §3.1、§3.3-3/4                          |
| 17  | Major   | O_EXCL 预检不防最终 rename 覆盖；import rename 可替换空目录                           | 修复：导出用 `link(partial, 最终名)` 发布（EEXIST 不覆盖）；导入先独占 `mkdir` 并记录 ino，再把暂存条目移入自建空目录；恢复表 + 事务日志 + 身份校验；登记失败与口令失败分别处理（77 保留导入）                                                                                           | §3.2-2、§3.3-5/8 与恢复表               |
| 18  | Major   | unref 定时器与 `process.exit` 管不住同步 FUSE/fsync                                   | 修复：重 IO 全部在受监督 worker 中，经管道回报真实进度，60 s 无进展 TERM→KILL→放弃；监督者不同步触碰挂载；退避期间持 ref'd 定时器；KILL 后迟到 IO ⇒ 事务未知 ⇒ fail closed                                                                                                               | §5                                      |
| 19  | Minor   | 验收自相矛盾（sessionDir 改动 vs 零 diff；删除开始后 Ctrl-C）                         | 修复：列出允许的差异（`.pi/settings.json` 与备份）；按阶段定义中断结果（提交前回滚、提交后忽略）；根目录 ctime 的变化只来自我们的改名/chmod；矩阵补齐 FUSE 链接、bind、ACL/xattr、源并发、日志 fsync 失败、回滚失败、同名竞态、迁址中断                                                  | §7.2、§7.4                              |
| 20  | Minor   | 结果语义不清                                                                          | 修复：结果对象；新增 79「已提交但部分收尾未完成」；取消为 1 且文案如实；130/143 说明实际结果；只有校验后才说「已回滚」；import 的 77 说明保留了什么；`run` 照旧透传 pi 退出码                                                                                                            | §1.4、§3.3-7/8、§6、Q13                 |
| 21  | Nit     | 去掉 `export.busy`；tar 可更简                                                        | 采纳：删除 `export.busy`，73 文案统一为「挂载、卸载或导出」；tar 保持最小（ustar + 只承载 path/size/mtime 的 pax），链接在 MANIFEST 中编码                                                                                                                                               | §3.1、§3.2-3、§7.5 G2                   |

评审其他意见已吸收：provenance 回填有预算（旧的无标记子会话可能短时可见）、hub 历史按生成号缓存（非即时）、同一 run 的所有 `subagent:run` 条目都要替换（§1.9、§2.3、§2.5）；Q3 注明域按进程冻结需重启（§4）。

注（r3）：#1、#3、#4、#5、#7、#20 所依赖的删除流程已在 r3 整体移除（用户拍板「不自动删除」），以上落点以 r2 为历史记录；当前设计见 §1、§2 与「§R2 评审处置」。

---

## §R2 评审处置

来源：`/tmp/secure-convert-review-r2.json`（verdict reject：6 Blocker / 1 Major / 1 Minor；r1 的 21 项中 12 项闭合、7 项部分闭合、2 项未闭合）。按 dev-flow 第三轮由主会话裁定，用户 2026-10-23 拍板「convert 不自动删除任何东西」；r3 照此落文，闭合由主会话核对。

| #   | 严重度                 | 摘要                                                                                                  | 裁定 / 处置                                                                                                                                                                                                                                                                                        | r3 落点                                                                    |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| B1  | Blocker                | 提交点（清 pending）早于 delete-intent，恢复按 delete-intent 决定回滚，已提交并接受新写入的库可能被删 | **消解 + 重定提交点**：删除事务整体移除，不再有 delete-intent；唯一提交点是建链接之后清除 `pending`。提交前 `pending` 使 unlock/run/export 全部拒绝，新库不可能被打开写入；`--abort` 以「登记项仍带本 txid 的 `pending`」为前提，提交后一律拒绝。退出码 79 删除                                    | §0；§1.4 第 13–14 步；§1.6；§3.5；§5 I-C2；§6                              |
| B2  | Blocker                | 只同步 WAL，未规定目标数据、会话 rename、密文目录项的持久化屏障，删源后断电可能丢唯一副本             | **消解（源从不删除，备份始终在）+ 补屏障**：建链接前对密文后端文件系统执行 `sync -f <realCipher>`（syncfs），拷贝中每个文件经挂载 fsync，`.txn/` 与相关父目录 fsync；屏障失败/超时 ⇒ 回滚。断电时备份仍在，不存在唯一副本窗口；备份由用户在核对后删除。`writeFileAtomic` 不承担持久化职责          | §1.4 第 11 步；§1.5「持久化屏障」「断电分析」；XC9；附                     |
| B3  | Blocker                | 删除恢复只核对 dev/ino/类型，不核对内容版本；旧 worker 结局未知时缺少禁止破坏性恢复的条件             | **消解**：不存在删除恢复。恢复动作只有「完成链接」或「删新库 + 备份改回原名」，都不修改或删除备份里的任何数据；被放弃的 worker 迟到的 IO 只能落进新库，删新库前要求已卸载、租约空闲、无占用，否则保留并报告。另在建链接前复核备份基线（ctime），备份被改动 ⇒ 回滚                                  | §1.4 第 12 步；§1.6；§5 worker 模型与 I-C1/I-C8；§7.2-5                    |
| B4  | Blocker                | 旧会话 rename→hash→unlink 不是写入互斥，可丢新消息；校验失败改回原名会覆盖新建文件                    | **消解**：旧会话只读复制，源不改名、不删；复制后再读源比对 size+sha256，不一致（被追加）⇒ 重试至多 3 次，仍不一致则报告，源始终不受影响。旧会话路径列出供手动删除                                                                                                                                  | §2.3；§7.1 sessions；§7.2-2                                                |
| B5  | Blocker                | xattr/ACL 等拒绝条件只在冻结前预检，冻结后新增的不可保留元数据会被吸收进新基线并随源删除丢失          | **修复 + 消解**：内容规则在冻结后的备份上完整重做（权威检查，结果以备份为准），原目录上的检查只用于早拒绝；且源从不删除，即使出现漏检，元数据也仍在备份中                                                                                                                                          | §1.3 导语；§1.4 第 6 步；§7.1 convert-preflight                            |
| B6  | Blocker（r2 新增）     | MANIFEST 链接的 path/of 未应用与 tar 成员相同的路径白名单与冲突校验，重建可写出暂存目录               | **修复**：统一路径验证器 `checkPkgPath` 覆盖 tar 成员、MANIFEST 每个条目的 `path` 与硬链接 `of`；链接计入同一数量/深度预算；成员与链接进入同一张路径表做重名与祖先类型冲突校验；链接只相对暂存根目录 fd 重建，逐段 lstat 父目录身份，`EEXIST` 拒绝；新增 MANIFEST 链接恶意语料并断言暂存根外零变更 | §3.3 第 2–5 步；§7.1 tar；§7.2-9                                           |
| M7  | Major（上轮 #7 遗留）  | 回滚 ENOENT 检查后的普通 rename 仍可覆盖并发创建的空目录，R31 表述过强                                | **修复**：改名一律用 `mv -n -T`（本机 coreutils 8.32 实测走 `renameat2(RENAME_NOREPLACE)`），以事后 lstat 身份判定成败（目标已存在时 mv 仍退出 0）；父目录文件系统限定为原生支持 NOREPLACE 的类型；R31 删除                                                                                        | §1.3 父目录行；§1.4 第 3 步；§1.5「改名不覆盖」；§1.6 R-B 第 3 步；XC8；§9 |
| m8  | Minor（上轮 #20 遗留） | convert 完成时 finalize 失败仍返回 0，与 79 语义未统一                                                | **明确例外**：79 已删除；convert 成功但收尾时挂载被占用而保持挂载，按 `run` 口径返回 0 并提示，已写入统一退出码表；提交失败为 74（`--resume` 完成）                                                                                                                                                | §1.4 第 14–15 步；§6                                                       |

其他主会话裁定的落点：原路径「转换期间不可用」改为「改名到建链接之间原路径不存在（含拷贝与校验时长），口令与确认都在改名前完成」（§0、§1.4 第 0 步）；会话复制源只读 + hash 复读校验（§2.3）；工作量重估为 8 人日（§8.1）。
