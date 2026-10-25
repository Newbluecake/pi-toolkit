# V2 报告 — `src/secure/bin/tree.mjs`（convert-plan r3 §1.3 / §1.5 / §5）

> 包：V2 tree（convert-plan §8.1）。文件域：`src/secure/bin/tree.mjs`（新）、`tests/secure/tree.test.ts`（新）、
> `tests/conformance/secure-convert-xc89.test.ts`（新，前置闸门 XC8/XC9，V7 整合进 `secure-convert.test.ts`）。
> 未碰 helper.mjs / `src/secure/*.ts` / tar.mjs / sessions.mjs；未接线到任何命令（V4/V6 做）；未 commit。
> **r3（2026-10-24）**：安全复审第 2 轮（3 Blocker）按主会话裁定处置，见文末「§安全复审第 2 轮处置」；I1/I4 的精确表述以该节为准。
> **r2（2026-10-24）**：按 V2 安全评审（gpt-6.1-sol，2 Blocker / 8 Major / 1 Minor，`/tmp/secure-V2-secreview.json`）与主会话裁定的威胁模型整体改为 fd 锚定实现，处置见文末「§安全评审处置」。下文 §1–§9 已按 r2 实现改写。

## 0. 前置闸门 XC8 / XC9（开工前跑，结果）

本机：Linux ext4（`/`、`/tmp` 同为 `/dev/sda1` ext4），coreutils 8.32，gocryptfs 1.8.0（go-fuse 2.0.3），strace 可用。
开工前先在 mktemp 里用假口令手工探测，随后固化为 `tests/conformance/secure-convert-xc89.test.ts`（自门控：XC8 需 Linux + GNU mv；XC9 需 gocryptfs/fusermount3/flock + 可用的 /dev/fuse；持 `gocryptfs-test-lock` 跨文件互斥）。

| #   | 事实                                                                                                                                                                                                                                           | 实测                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| XC8 | `mv -n -T -- a b`，b 为**空目录**：`renameat2(AT_FDCWD,"a",AT_FDCWD,"b",RENAME_NOREPLACE) = -1 EEXIST`，**退出 0**，a、b 的 inode 都不变、b 仍为空                                                                                             | ✅ strace 断言；且不出现普通 `rename`/`renameat`                                                                     |
| XC8 | b 为普通文件：同样 EEXIST、退出 0、b 内容不变                                                                                                                                                                                                  | ✅                                                                                                                   |
| XC8 | b 不存在：恰好一次 `renameat2(…RENAME_NOREPLACE) = 0`，b 的 inode = a 原来的 inode                                                                                                                                                             | ✅                                                                                                                   |
| XC8 | `/tmp` 的 statfs f_type ∈ 白名单（ext4 0xEF53）                                                                                                                                                                                                | ✅                                                                                                                   |
| XC8 | `renameNoReplace` 对「退出 0 但未移动」判失败（`state:"unchanged"`）                                                                                                                                                                           | ✅                                                                                                                   |
| XC9 | 经挂载写 1 MiB、**未 fsync、fd 未关闭**时，后端密文文件已是完整密文大小 `18 + 1048576 + 256×32 = 1056786`（未协商 FUSE 写回缓存：写请求返回即已交给后端）                                                                                      | ✅（关闭后不变）                                                                                                     |
| XC9 | `strace sync -f -- <cipher>` ⇒ `syncfs(3) = 0`，无全局 `sync()`                                                                                                                                                                                | ✅                                                                                                                   |
| +   | `syncBarrier({syncfs:[dirTarget(cipher)], fsyncDirs:[dirTarget(tmp)]})` 成功；`copyTree` 拷进**真实 gocryptfs 挂载**（含 9 MiB 文件、只读文件、0500 目录、硬链接、相对/悬空绝对符号链接）+ `verifyCopy` 经挂载读回零差异，挂载内硬链接同 inode | ✅（证明 O_EXCL\|O_NOFOLLOW、fchmod/futimes、`symlink`+`lutimes`、`link()` 与目录 mode/mtime 在 gocryptfs 上都成立） |

结论：§1.5 的两条设计前提成立——改名必须以事后 lstat 身份判定（mv 退出码不可信）；屏障做在后端（`sync -f` = syncfs）。r2 起屏障对**已核对身份的目录 fd** 执行（`sync -f /proc/<pid>/fd/<fd>`）。

## 1. API（`tree.mjs` 导出，供 V4/V6）

零依赖 ESM，**不 import helper.mjs**（V6 中 helper 会 import 本文件，避免环）。所有失败抛 `TreeError {code, exit, rel?}`（`exit` 为 §6 建议码，V4 决定）。带 `_hooks` 的参数是**仅供测试**的确定性竞态注入点（只能通过直接调用传入，worker spec 不接受）。

**fd 锚定原语**（贯穿全部实现）：子项一律以 `/proc/self/fd/<父目录fd>/<name>` 解析（父目录对象已被 fd 钉住，路径被换不影响）；末段 `O_NOFOLLOW`；子进程用 `/proc/<pid>/fd/<fd>`（`childFdPath`）。`O_PATH`（Node 未导出，取 Linux 值 `0o10000000`）钉住 inode 而不需要读权限；chmod 只通过 `fchmod(fd)` 或对 O_PATH fd 的 `/proc/self/fd/<fd>` 魔链接 `chmod`——两者都绑定 inode，从不按路径名。

### 1.1 遍历 / 清单

| 签名                                                                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walkTree(root, {onProgress?, expectRoot?, maxDepth=256}) → Manifest` | 根以 `O_DIRECTORY\|O_NOFOLLOW` 打开（可选绑定 `expectRoot`）；每个子项经**父目录 fd** lstat/readlink；子目录从父 fd `O_NOFOLLOW` 打开且须是 lstat 看到的 inode；fdinfo `mnt_id` ≠ 根 ⇒ 记 `mount` 不进入；同时打开的目录 fd ≤ 深度。`Manifest = {v:1, root, rootId, rootMntId, entries, walkProblems}`；`Entry = {rel, type, mode, uid, gid, size, nlink, dev, ino, mtimeNs, ctimeNs, atimeNs, target?}` |
| `manifestSummary(m)` / `gitEntries(m)`                                | 统计；所有 `.git` 位置（V4 在此跑 §1.3.1 git 规则）                                                                                                                                                                                                                                                                                                                                                      |
| `writeManifestFile(file, m)` / `readManifestFile(file)`               | NDJSON（头行含 `rootId`、`rootMntId`、`count`），独占 0600 + fsync 文件与父目录；读取拒绝符号链接/非普通文件/他人属主/截断                                                                                                                                                                                                                                                                               |
| `fdAt(dirfd, name)` / `childFdPath(fd)` / `mntIdOf(fd)`               | 锚定路径与挂载 id                                                                                                                                                                                                                                                                                                                                                                                        |

### 1.2 规则（§1.3，V2 负责的部分）

| 签名                                                                                                                                    | 说明                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkTree(root, {uid?, gid?, linkRoots?, extraRoots?, mountinfo?, mountinfoAfter?, getfattrBin?, envPath?, expectRoot?, onProgress?})` | **一个一致快照**：mountinfo → 遍历 M1 → 逐条目规则 → fd 锚定 xattr → 遍历 M2（须与 M1 逐字段相等，含 ctime）→ mountinfo。返回 `{manifest(=M2=M1), problems, counts, total, truncated, warnings, gitEntries, summary, estimate, exit}`。**V4 必须把这个 manifest 直接作为第 6 步基线**（worker `check` 的 `manifestOut`），绝不在检查后另取基线 |
| `checkTreeRules(m, {uid?, gid?, linkRoots?})`                                                                                           | 逐条目规则（见 §2）                                                                                                                                                                                                                                                                                                                            |
| `classifyLink(rel, target, linkRoots)`                                                                                                  | 纯词法：`rel-internal`/`escape`/`abs-internal`/`abs-external`/`invalid`                                                                                                                                                                                                                                                                        |
| `mountsInside` / `mountProblems` / `mountFor` / `parseMountinfo` / `readMountinfo`                                                      | mountinfo 规则                                                                                                                                                                                                                                                                                                                                 |
| `parseGetfattrDump(text)` / `scanXattrs(m, {bin?, envPath?, onProgress?, batchMs?})`                                                    | 见 §2 xattr 行                                                                                                                                                                                                                                                                                                                                 |
| `checkParentDir(parentReal, {uid?, statfs?, mountinfo?, lstat?})`                                                                       | 父目录规则 + 文件系统类型白名单                                                                                                                                                                                                                                                                                                                |
| `createProblems` / `formatProblems(res, 20)` / `problemsExit(res)`                                                                      | 有界收集（前 200 条、精确计数）、中文行 ≤20 + 尾行、建议码 69 > 65 > 74                                                                                                                                                                                                                                                                        |

**V4 注意**：权威检查在备份上跑时 `root` = 备份路径、`expectRoot` = 改名后确认的备份 (dev,ino)，`linkRoots` 必须传**原路径**的字面与 realpath。路径类规则、git 规则与占用扫描属于 V4。

### 1.3 空间

`gocryptfsCipherSize(size)`、`estimateVaultUsage(m, {extraBytes?, extraInodes?})`、`statfsInfo(p, statfs?)`、`checkSpace(info, est)`（`space`/`inodes`，建议 74）。

### 1.4 改名

- `renameNoReplace({parent, from, to, expect:{dev,ino}, expectParent?, mvBin?, deadline?, spawnImpl?}) → Promise<{ok:true, mv} | {ok:false, state:"unchanged"|"unknown", reason, mv?}>`（§3）
- `backupName(base, now?, rand?)` ⇒ `<base>.pi-secure-backup-<YYYYmmdd-HHMMSS>-<4 hex>`。

### 1.5 只读 / 恢复 / 基线

- `freezeTree(root, modesFile, {expectRoot?, mountinfo?, onProgress?}) → {entries, changed, rootId}`
- `restoreModes(root, modesFile, {onProgress?}) → {ok, restored, unchanged, skipped:[{rel, reason}]}`；`readModesFile(file)`
- `takeBaseline(root, {expectRoot?})`（= `walkTree`）、`compareBaselines(a, b) → [{rel, kind, fields?}]`（含 rootId / rootMntId / walk 问题）

### 1.6 拷贝 / 校验 / 屏障 / 探测

- `copyTree({src, dst, baseline, modes?, expectDst?, applyRootMeta=true, onProgress?}) → {files, links, symlinks, dirs, bytes, hashes, dstId}`
- `verifyCopy({dst, baseline, modes?, hashes, expectDst?, applyRootMeta=true, onProgress?}) → {ok, diffs, checked}`
- `syncBarrier({syncfs:[{path,dev,ino}…], fsyncDirs:[{path,dev,ino}…], syncBin?, timeoutMs=60s}) → {ok, steps, reason?}`；`dirTarget(p) → {path, dev, ino}`（调用方在确认无误时记录）
- `probeTreeTools({scratchParent, mvBin?, syncBin?, getfattrBin?, envPath?}) → Promise<{ok, missing, leftover}>`
- `writeHashesFile` / `readHashesFile`

### 1.7 worker 协议

```
argv   : <node> <tree.mjs> __tree-work <op>      （V6 可改为 helper.mjs __convert-work <op> → import("./tree.mjs").workerMain(op)）
stdin  : 一个 JSON spec，随后 EOF（≤16 MiB）
stdout : JSON 行 —
         {"t":"progress","op":…,"units":n,"bytes":b}            累计值，严格递增（无增量的 tick 不发）
         {"t":"result","op":…,"ok":true,"result":{…}}            成功时恰好一次
         {"t":"error","op":…,"code":"…","exit":n,"message":"…"}  失败时恰好一次
exit   : 0 result · 1 error · 2 入口拒绝未知 op（不读 spec）
```

| op                 | spec                                                                                   | result                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `check`            | `{root, expectRoot?, linkRoots?, extraRoots?, uid?, gid?, getfattrBin?, manifestOut?}` | `checkTree` 结果去掉 `manifest`，加 `rootId`（`manifestOut` = 基线文件） |
| `freeze`           | `{root, modesFile, expectRoot?}`                                                       | `{entries, changed, rootId}`                                             |
| `restore-modes`    | `{root, modesFile}`                                                                    | `restoreModes` 结果                                                      |
| `baseline`         | `{root, manifestOut, expectRoot?}`                                                     | `{entries, rootId, walkProblems}`                                        |
| `compare-baseline` | `{root, baselineFile}`                                                                 | `{same, diffs}`（根绑定基线 rootId）                                     |
| `copy`             | `{src, dst, baselineFile, modesFile?, hashesOut, expectDst?, applyRootMeta?}`          | 拷贝统计 + `hashed` + `dstId`                                            |
| `verify`           | `{dst, baselineFile, modesFile?, hashesFile, expectDst?, applyRootMeta?}`              | `verifyCopy` 结果                                                        |
| `sync`             | `{syncfs:[{path,dev,ino}…], fsyncDirs:[{path,dev,ino}…], syncBin?, timeoutMs?}`        | `syncBarrier` 结果（失败 ⇒ error `barrier`）                             |

- `runTreeOp(op, spec, emit)` / `workerMain(op, {stdin?, write?})` / `treeWorkerArgv(op)` / `WORKER_OPS` / `scanGroup(pgid, procRoot?) → {complete, members, leader}` / `groupMembers(pgid, procRoot?) → pid[] | null`（扫描不完整 ⇒ null）/ `readProcStart(pid)`。
- `superviseWorker({op, spec, argv?, env?, stallMs=60s, killGraceMs=2s, abandonMs=1s, onProgress?, spawnImpl?, procRoot?})` ⇒ `{kind:"result"}` | `{kind:"error", code, exit, message, rel?}`（含 `code:"protocol"`）| `{kind:"stalled"}`（结果未知 ⇒ V4 回滚）| `{kind:"crashed"}` | `{kind:"unclean", outcome, leftover:[pid], scan:"complete"|"incomplete", killed}`（组内仍有成员，或 /proc 扫描不完整 ⇒ V4 按未知处理）| `{kind:"spawn-error"}`。

## 2. 收窄规则：拒绝点与测试

| §1.3 规则                                          | 拒绝点（code）                                                                                                                                                                             | 测试（`tests/secure/tree.test.ts`）                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 挂载点（含同 fs bind、文件 bind、overlay、根本身） | `mountsInside`：解码 `\ooo` 后与字面 + realpath 两种 root 写法比较，前缀按路径段（`/proj2` 不算 `/proj` 之内）（`mount`）                                                                  | mountinfo 组 5 例 + `checkTree` 真实树注入                                                           |
| 属主 / 组                                          | 任一条目 `uid ≠ 本用户`（`owner`）/ `gid ≠ 主组`（`group`）                                                                                                                                | 注入 uid/gid：每个条目都被列出                                                                       |
| 类型                                               | FIFO / socket / 字符 / 块设备（`type`）                                                                                                                                                    | 真 `mkfifo` + 真 unix socket                                                                         |
| 不可读 / 不可进入                                  | 文件缺 `u+r`、目录缺 `u+rx`（`unreadable`）；`readdir` 失败另记 walk 问题                                                                                                                  | mode 000 文件 + 000 目录                                                                             |
| 特殊位                                             | `mode & 0o7000`（`special-bits`）                                                                                                                                                          | setuid 文件、setgid 目录、sticky 目录                                                                |
| 扩展属性                                           | 有任何属性 ⇒ `xattr`；getfattr 非零退出/超时 ⇒ `xattr-uncertain`（拒绝）；getfattr 不在 PATH ⇒ `prereq`（69）                                                                              | 注入假 getfattr（命中两条、报错、缺失）、解析含转义的 dump、批次 ≥2 时每批一个进度                   |
| 外部硬链接                                         | 普通文件 `nlink` > 树内同 (dev,ino) 出现次数（`ext-hardlink`）                                                                                                                             | 树外建一条硬链接；树内组不报                                                                         |
| 符号链接                                           | 相对链接词法解析逃出根 ⇒ `escape-link`；空/含 NUL ⇒ `escape-link`；树外绝对 ⇒ `warnings`（`abs-external-link`）；树内相对/绝对、悬空允许                                                   | `classifyLink` 表 11 例 + 真实树（`../../outside`、`..`）                                            |
| 被硬链接的符号链接（新增）                         | 符号链接 `nlink > 1`（`hardlinked-symlink`）                                                                                                                                               | `link(2)` 对符号链接建硬链接                                                                         |
| 非 UTF-8 名字（新增）                              | 文件名或链接文本不是合法 UTF-8（`name-encoding`），条目不入清单                                                                                                                            | `0xff 0xfe` 文件名                                                                                   |
| 遍历期间的替换/跨挂载（评审新增）                  | 子项经父目录 fd 解析；lstat→readlink→lstat 不一致、子目录打开后身份不符 ⇒ `unstable`；子目录 fdinfo `mnt_id` ≠ 根 ⇒ `mount`（不进入）；读不到 ⇒ `mount-uncertain`；深度 > 256 ⇒ `too-deep` | 安全回归 #3（中途把目录换成符号链接）、mountinfo 组                                                  |
| 检查期间树变化（评审新增）                         | 第二次遍历必须与第一次逐字段相等（含 ctime）⇒ 否则 `changed-during-check`；两次 mountinfo 任一发现挂载即拒绝                                                                               | 安全回归 #7（xattr 扫描中换 inode、getfattr 期间 chmod、检查后出现挂载）                             |
| 父目录                                             | 非目录（`parent-not-dir`）、非本用户（`parent-owner`）、组/他人可写（`parent-mode`）、本用户不可写（`parent-not-writable`）                                                                | 逐条注入                                                                                             |
| 父目录文件系统类型                                 | statfs f_type **与** mountinfo 服务该路径的挂载项类型都须在 {ext4, xfs, btrfs, f2fs, tmpfs}（`fs-type`）                                                                                   | overlay/fuse magic、mountinfo 为 fuse.sshfs、mountinfo 缺项各拒绝；五种白名单各通过；真实 tmp 父目录 |
| 空间 / inode                                       | `avail < est×1.10 + 64 MiB`（`space`）；`ffree < inodes×1.10 + 64`（`inodes`；btrfs `f_files=0` 时跳过）；建议 74                                                                          | 边界值 ±1、inode、无 inode 表                                                                        |

问题清单逐条列出时最多 20 条（`formatProblems`），机器结果保留前 200 条并精确计数（`checkTree` 260 个他组文件计数 261 测试）。

## 3. 改名与身份判定（I-C6）

`renameNoReplace`（**从不看 mv 退出码**）：

1. 参数：`parent` 绝对路径；`from`/`to` 单一路径分量、互不相等；`expect` 必填，`expectParent` 可选。
2. 父目录以 `O_DIRECTORY|O_NOFOLLOW` 打开为 `pfd`；`fstat(pfd)` 须等于 `expectParent`（给出时），且此刻 `lstat(parent)` 须解析到同一对象——否则 `unchanged`，不运行 mv。
3. 经 `pfd` 预检：`from` 须是 `expect`，`to` 须不存在。
4. `mv -n -T -- <from> <to>`，**cwd = `/proc/<pid>/fd/<pfd>`**：内核把魔链接解析到被钉住的目录对象，父路径中途被换（ABA）无法把 mv 带到别处；两个名字都是单分量 ⇒ EXDEV（mv 唯一会退化为「拷贝 + 删除」的错误）不可能出现；`from` 上有挂载点时内核返回 EBUSY，mv 不拷贝。父目录类型白名单保证 `RENAME_NOREPLACE` 由内核原子实现。截止（默认 10 s）或正常结束后都要把 mv 的进程组杀净并确认（`groupMembers`），有残留 ⇒ `unknown`。
5. 事后观察全部经 `pfd`：`from` 不存在 ∧ `to` = `expect` ⇒ `ok`；`from` 仍 = `expect` 且 `to` ≠ `expect` ⇒ `unchanged`；其他 ⇒ `unknown`。另外 `lstat(parent)` 若已不再解析到 `pfd` ⇒ **一律 `unknown`（`parent-path-changed`）**，即使移动确实发生，也绝不返回 `unchanged`。

测试：正常移动；预检后插入同名空目录（mv 退出 0、判失败、目标未被替换）；目标已存在 ⇒ 不运行 mv；假 mv `exit 0` ⇒ `not-moved`；假 mv「cp -a + rm -rf」⇒ `unknown`；身份不符/非法名字 ⇒ 不运行 mv；mv 卡住 ⇒ 截止 KILL；**父目录 ABA**（mv 前把 P 换成指向 Q 的符号链接，mv 后换回）⇒ 移动发生在真正的 P 内、Q 原样；**父路径换后不复原** ⇒ `unknown/parent-path-changed`、Q 原样。

## 4. 只读、恢复、基线

- `freezeTree`：先 fd 锚定遍历；**遍历有任何问题（另一挂载、unstable、unreadable、too-deep…）或 mountinfo 显示树内有挂载 ⇒ 拒绝，一个 mode 都不改、不写 `.modes`**。否则先把 `{rel, type, mode, dev, ino}` 写入 `.modes`（独占 0600 + fsync），再做后序 chmod：每个目录从已钉住的父目录 `O_PATH|O_DIRECTORY|O_NOFOLLOW` 钉住且须是记录的 inode，每个普通文件 `O_PATH|O_NOFOLLOW` 钉住且须是记录的 inode，经 `chmodFd` 修改并回读确认。任何不符 ⇒ 抛 `identity` 停止（调用方用 `.modes` 恢复）。**不再有任何按路径名 chmod 的降级**（0200 这类不可读文件经 O_PATH 魔链接处理）。
- `restoreModes`：根以 `.modes` 头里的 rootId 绑定（改名后的备份照样恢复）；同一个 fd 链逐级核对；缺失/被替换的条目（及被替换目录的整棵子树）跳过并报告；只 chmod，绝不改内容。
- 基线 = `checkTree` 返回的清单；第 12 步用 `compare-baseline`（根绑定基线 rootId）比较 type/dev/ino/size/mtime/ctime/mode/nlink/uid/gid/target 与 rootId/rootMntId。

## 5. 拷贝与校验（§1.5 表）

| 对象     | 拷贝                                                                                                                                                                                                                        | 校验                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 普通文件 | 源经父目录 fd `O_RDONLY\|O_NOFOLLOW`，读前读后 fstat 须与基线 (dev,ino,size,mtime,ctime) 一致；目标经**自建目录 fd** `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW` 0600；流式 sha256；`fchmod` → `futimes` → `fsync`（全部对 fd） | 经父目录 fd `O_NOFOLLOW` 打开，**从同一 fd 读哈希**，读前读后 fstat 一致；类型/原 mode/size/mtime(ms)/nlink |
| 目录     | 经父 fd `mkdir 0700` → 经父 fd `O_DIRECTORY\|O_NOFOLLOW` 打开 → 须是本用户、同挂载、空目录 → 子项全部经**这个 fd** 创建；后序对该 fd `fchmod` + `futimes`                                                                   | 子项名集合与基线完全相等；mode/mtime；同挂载                                                                |
| 符号链接 | 源 lstat→readlink→lstat 一致且等于基线；经自建目录 fd `symlink` + `lutimes`，回读确认                                                                                                                                       | lstat→readlink→lstat 一致；文本逐字节相等                                                                   |
| 硬链接   | 首个正常拷贝；其余：经已记录身份的目标目录链重新钉住首个副本所在目录，核对首个副本 inode 后 `link()`，再核对新名字 inode                                                                                                    | 组内同一 inode、`nlink` = 组大小                                                                            |
| 稀疏文件 | 展开写满                                                                                                                                                                                                                    | 内容一致                                                                                                    |

- 源根须是基线 rootId 且挂载 id 与基线一致；目标根 `O_DIRECTORY|O_NOFOLLOW`、须为空（可绑定 `expectDst`）。
- **最终复核**：校验过程中记录每个对象的 fstat 快照；结束时 fd 锚定重新遍历目标（根绑定），与快照逐字段比较，任何变化 ⇒ `changed-after-check` 失败。
- 时间：写入值取「该毫秒的中点」，校验按 `floor(ns/1e6)` 精确相等。

## 6. 持久化屏障

`syncBarrier` 只接受 `{path, dev, ino}` 目标，`syncfs` 与 `fsyncDirs` **都必须非空**（空规格 ⇒ `empty-spec`，从不算成功）。每个目标以 `O_DIRECTORY|O_NOFOLLOW` 打开并核对 (dev,ino)，不符 ⇒ 失败；`syncfs` 对 `/proc/<pid>/fd/<fd>` 跑 `sync -f`（对被钉住目录所在文件系统执行 syncfs，XC9），`fsyncDirs` 对 fd 做 fsync。应传 `realCipher`（挂载时记录的身份）与 `<dir>`、`<mnt>` 父目录、`.txn/`。

## 7. 预算表

| 项                   | 上限                                                                                                                 | 位置              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------- |
| worker 停滞看门狗    | 60 s 无**严格递增**的本 op 进度 ⇒ TERM 组 → +2 s 清理：KILL 组直到 /proc 中无成员，≤ 2 s + 1 s；仍有成员 ⇒ `unclean` | `superviseWorker` |
| 正常结束的清理       | 同样扫描 + KILL + 确认组空（≤ 3 s）                                                                                  | `superviseWorker` |
| 已报结果但不退出     | 看门狗到期 ⇒ 清理，保留结果                                                                                          | `superviseWorker` |
| worker stdout / spec | 64 MiB ⇒ 杀组、`output-too-large`；spec 16 MiB                                                                       | —                 |
| progress 粒度        | 每 256 条目 / 每 8 MiB / 每个 getfattr 批次（跨阶段累计）                                                            | 各 op             |
| `mv -n -T`           | 10 s 截止；结束后组清理 ≤ 1 s；残留 ⇒ `unknown`                                                                      | `renameNoReplace` |
| getfattr             | 每批 ≤64 KiB 参数、≤64 个钉住目录、30 s（SIGKILL）、输出 ≤16 MiB                                                     | `scanXattrs`      |
| `sync -f`            | 60 s（SIGKILL）⇒ 失败                                                                                                | `syncBarrier`     |
| 遍历深度 / fd        | ≤256 层；同时打开的目录 fd ≤ 深度（拷贝/校验 ≤ 2×深度）                                                              | `walkTree` 等     |
| 问题 / 差异          | 保留 200、显示 20、计数精确                                                                                          | —                 |

看门狗计时器 `unref`（子进程句柄保持事件循环存活）；升级与清理阶段的计时器 **ref**（有界），保证监督者不会在 promise 未结算时退出。

## 8. 偏差（相对 plan 字面）

1. **getfattr 不用 `-R`**：对清单中每个对象以 `/proc/<pid>/fd/<父目录fd>/<name>` 分批调用（`-h` 检查末段本身）；`-d` 模式下无属性的文件不输出，`-R` 无法产生进度；按清单分批还保证检查的就是遍历过的对象。
2. **新增拒绝**：非 UTF-8 名字/链接文本；被硬链接的符号链接；（r2）遍历中被替换（`unstable`）、子目录跨挂载 id（`mount`）、挂载 id 不可读（`mount-uncertain`）、深度 > 256（`too-deep`）、检查期间变化（`changed-during-check`）。
3. 父目录文件系统类型双重确认（statfs 与 mountinfo）。
4. mv 在父目录 fd 内运行（cwd = 魔链接），而不是绝对路径两端。
5. `check` 不含路径/git/占用规则（V4）。
6. `restoreModes` 按 (dev,ino) 认条目并跳过冒名者。
7. （r2）基线 = `checkTree` 返回的清单（plan 第 6 步写作「通过后 lstat 全树取基线」——改为「检查用的那份快照本身就是基线」，消除「检查后重取基线吸收未检查变化」的窗口）。

## 9. 残留（均引用威胁模型：同 uid 定向恶意进程不在防护范围；良性并发修改由 V4 的 §1.3 占用检查排除）

**不变量的精确表述（r3，主会话裁定）**：

- **I1**：绝不删除非本次创建的**数据**；全文件唯一的删除出口是探针清理的 `rmdirOwned`（只删空目录）。唯一残留：同 uid 定向竞态在 lstat→rmdir 窗口换入的**空目录**可能被删除。
- **I4**：**在占用检查成立的前提下**（§1.3：同 uid 进程的 cwd/exe/fd/maps 都不在树内，即没有并发写入者），校验与屏障在对象不一致时不会报告成功。所有版本比较使用纳秒精度字段（见 §安全复审第 2 轮处置 B2 的证据）。
- **I5**：只有**完整**枚举 /proc 并确认组空才算干净；枚举不完整或成员杀不掉 ⇒ `unclean`，不会返回正常结局。

- **探针 rmdir 窗口（I1 残留）**：`rmdirOwned` 先经钉住的父目录 fd 核对 inode 再 `rmdir`，两步不是原子的。只有在这个窗口内把我们的空目录换成另一个空目录的同 uid 定向竞态，才能让替身被删；探针目录是本进程 `mkdtemp` 的 0700 私有目录，良性进程不会往里换入；`rmdir` 只能删空目录，任何文件数据都不可能丢失。收紧：清理前先确认临时目录仍在原名下（被移走则一律不动）、遇到第一个失败立即停止并全部报告、rmdir 后确认名字已消失；探针中途的 rmdir 已取消（改为移到从未使用的名字 `c`）。
- **纳秒字段上的同 tick 碰撞（I4 前提）**：版本比较全部用 bigint stat 的 `mtimeNs`/`ctimeNs` 字符串 + dev/ino/size/mode，但内核用粗粒度时钟（~1–4 ms，6.13 以前无多粒度时间戳）**写入**这些字段，同一 tick 内的两次改动可得到相同的纳秒值。能制造这种碰撞的只有与转换并发的写入者：良性写入者被 §1.3 占用检查排除，定向竞态不在威胁模型内。拷贝时每个文件读前读后都核对；备份保留到用户核对后自行删除（R33 同理）。
- **xattr 名字 ABA（I4 前提）**：getfattr 接收「钉住的父目录 + 名字」，名字在调用期间被换成别的 inode 再换回且时间戳碰撞时，第二次遍历发现不了。同上：需要并发写入者（被占用检查排除）或定向竞态（不在范围）。真实 getfattr 对 `/proc/<pid>/fd/<fd>/<name>` 路径的输出格式在本机无法验证（未装 attr 包）；映射失败时问题仍以 `path` 报告并拒绝（fail closed）；V7 的 XC7 需在装有 getfattr 的机器上验证。
- **mountinfo 与文件 bind**：目录挂载由每个目录 fd 的 `mnt_id` 实时发现；文件 bind mount 只能靠检查前后两次 mountinfo。两次之间出现又消失的文件 bind 无法发现——需要挂载权限与定向时机（不在范围内）。
- **D 状态成员**：KILL 无效时返回 `unclean`（附 pid 列表与 `scan` 完整性），由 V4 按「未知」回滚；进程本身无法回收。
- **进程组归属证明**：组长已被回收后，只有完整扫描到 pgrp 相同、启动时间不早于组长的存活成员，且没有别的进程占用 pid = pgid 时才发信号（内核不会把仍被用作 pgid 的 pid 分配给新进程）；证明不了就不发信号，结果为 `unclean`。
- **`/proc/<pid>/fd` 访问前提**：子进程（mv/getfattr/sync）需要能访问本进程的 `/proc/<pid>/fd`（同 uid 且进程可转储）；不满足时这些步骤失败（fail closed）。
- 目标根应用原根 mode（`applyRootMeta`）：原根若无 `u+w`，V4 第 9 步写 `.pi/settings.json` 会失败——V4 需要时传 `applyRootMeta:false` 或临时处理。
- `scanXattrs` 每个父目录按 fd 链重新钉住（O(深度) 次 open）；`getfattr` 每批一个进程——耗时与数据量成正比，受停滞看门狗约束。
- conformance XC9 依赖跨文件 gocryptfs 测试锁；多个 agent 同时跑真实挂载测试时会排队（锁等待 560 s，beforeAll 600 s）。

## §安全评审处置（r2，2026-10-24）

来源：`/tmp/secure-V2-secreview.json`（gpt-6.1-sol：2 Blocker / 8 Major / 1 Minor；kimi 验收已通过）。威胁模型按主会话裁定（同 uid **定向**恶意进程不在范围；良性并发由占用检查排除），但 I1–I5 在任何竞态下都成立、不依赖「没人捣乱」。回归测试位于 `tests/secure/tree.test.ts` 的「security review regressions (I1–I5)」块，用仅供测试的 `_hooks` 注入确定性交错，并断言**树外对象**未被触碰。

| #   | 严重度  | 问题                                                  | 处置（落点）                                                                                                                                                                                                                                                                             | 测试                                                                                                                                                                                                                                                                          |
| --- | ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | `probeTreeTools` 无条件递归删除                       | 在 `scratchParent` 的 fd 内 `mkdtemp`，里面只建两个**空目录**（不建任何文件）；清理 `rmdirOwned`：经钉住的父目录 lstat，身份等于本次创建的才 `rmdir`（rmdir 只能删空目录）；任何不符 ⇒ 留下并在 `leftover` 报告。全文件已无 `rmSync`/`unlink`/递归删除（见 grep）                        | 「#1 probe」：mkdtemp 后把临时目录移走、原位换成含金丝雀文件的目录 ⇒ 金丝雀完好、`leftover` 含该路径、移走的那份里只删了自己的 a/b                                                                                                                                            |
| 2   | Blocker | `copyTree` 未绑定目标目录；目录元数据恢复跟随符号链接 | 目标根 `O_DIRECTORY\|O_NOFOLLOW` fd；每个新目录经父 fd mkdir、经父 fd `O_NOFOLLOW` 打开并核对（本用户、同挂载 id、空），之后所有子项经**这个 fd** 创建；目录 mode/mtime 只对其 fd `fchmod`/`futimes`；符号链接 `lutimes`；硬链接经已记录身份的目录链钉住首个副本再 `link()` 并核对 inode | 「#2 copy」两例：mkdir 后、打开前把新目录换成指向树外 E 的符号链接 ⇒ 失败；打开后再换 ⇒ 写入留在我们的目录对象内（`src.moved`），E 的条目/mode/mtime 零变化，verify 失败                                                                                                      |
| 3   | Major   | `walkTree` 子项经原路径重解析；freeze 可改树外        | 遍历全程保持父目录 fd，子项经 `/proc/self/fd/<父fd>/<name>`；子目录 `O_NOFOLLOW` 打开并核对 inode 与 mnt_id；freeze 的 chmod 走钉住的 fd；遍历有问题或 mountinfo 有挂载 ⇒ freeze 拒绝且不改任何 mode                                                                                     | 「#3 walk」：列完 `src` 后把它换成指向 E 的链接 ⇒ 清单不含 E 的 inode、内容来自真实目录对象；「#3/#4 freeze」：chmod 前把 a.txt 换成指向树外 F 的链接 ⇒ 停止、F 的 mode 不变、恢复时只跳过 a.txt；「#3 freeze refuses」：树内挂载 / 不可读目录 ⇒ 拒绝、无 `.modes`、mode 不变 |
| 4   | Major   | `chmodEntry` 的 EACCES 降级为路径名 chmod             | 删除降级。`chmodFd`：`fchmod(fd)`；O_PATH fd（EBADF）时对 `/proc/self/fd/<fd>` 魔链接 chmod——绑定的是钉住的 inode；之后回读确认                                                                                                                                                          | 冻结测试中的 0200 文件经 O_PATH 成功；「#3/#4 freeze」断言换入的符号链接目标 mode 不变                                                                                                                                                                                        |
| 5   | Major   | `renameNoReplace` 父目录 ABA                          | 父目录 fd 钉住，mv 的 cwd = `/proc/<pid>/fd/<pfd>`，前后观察全部经 fd；父路径事后不再解析到 fd ⇒ `unknown`（不返回 `unchanged`）；可选 `expectParent`；mv 进程组结束后杀净确认                                                                                                           | 「#5 rename」两例：ABA 换回 ⇒ 移动发生在真 P 内、诱饵 Q 原样；不换回 ⇒ `unknown/parent-path-changed`、Q 原样                                                                                                                                                                  |
| 6   | Major   | `verifyCopy` 元数据与哈希不是同一对象                 | 每个文件经父目录 fd `O_NOFOLLOW` 打开，元数据与哈希来自**同一 fd**，读前读后 fstat（dev,ino,size,mtime,ctime）一致；组成员按 fd 的 inode 比对；结束时重新遍历并与校验快照比较                                                                                                            | 「#6 verify」三例：已校验文件随后被换成错误文件 ⇒ `changed-after-check`；被哈希的文件读后被替换 ⇒ 失败；读后被追加 ⇒ `unstable`                                                                                                                                               |
| 7   | Major   | 规则/mountinfo/xattr 无快照一致性                     | `checkTree` 改为单一快照闭环（mountinfo → M1 → 规则 → fd 锚定 xattr → M2 须逐字段等于 M1 → mountinfo；两次 mountinfo 任一有挂载即拒绝）；返回的清单就是基线，禁止检查后重取基线。名字→inode 的 xattr 绑定为尽力而为（见 §9 残留，理由：ctime 版本号 + 定向攻击不在范围）                 | 「#7 check」：xattr 扫描前把 ro.txt 换成新 inode ⇒ `changed-during-check:ro.txt`；检查后出现挂载 ⇒ `mount`；getfattr 期间 chmod ⇒ `changed-during-check:a.txt`                                                                                                                |
| 8   | Major   | `syncBarrier` 不绑定身份；空规格算成功                | 目标必须是 `{path,dev,ino}`，打开 `O_DIRECTORY\|O_NOFOLLOW` 并核对后对 `/proc/<pid>/fd/<fd>` 执行 `sync -f`、对 fd fsync；`syncfs` 或 `fsyncDirs` 为空 ⇒ `empty-spec` 失败；新增 `dirTarget()`                                                                                           | 「#8 barrier」：空规格/缺身份/路径被换成新目录/路径被换成符号链接 ⇒ 全部失败                                                                                                                                                                                                  |
| 9   | Major   | 组长先退出会取消后续 KILL                             | 进入升级后组长退出不再结算；任何结局（正常结束、停滞、输出过大、已报结果但不退出）都先扫描 /proc 的 pgid，有活成员就 KILL 并轮询到组空（有界），仍有成员 ⇒ `unclean`；清理计时器 ref；mv 的 `runChild` 同样处理                                                                          | 「#9 supervisor」两例：组长遇 TERM 退出、忽略 TERM 且 stdio 独立的后代被 KILL，组为空；正常结束遗留后代 ⇒ 结果保留、组为空；原「忽略 TERM 的组长」用例保留                                                                                                                    |
| 10  | Minor   | 接收端不校验结构；无增量进度也算进展                  | 终态行校验 op 一致、`result` 为 `{ok:true, result:{…}}` 且进程自行退出码 0、`error` 带字符串 code；重复终态 ⇒ `protocol`；进度只接受本 op 且 units/bytes 严格增加的行；worker 侧把各阶段计数折算为严格递增的累计值                                                                       | 「#10 protocol」：op 不符 / `ok:false` / 重复终态 / result 后退出码 5 ⇒ `protocol`；重复相同进度、别的 op 的进度 ⇒ 仍判停滞                                                                                                                                                   |

评审中的说明性意见同步处理：报告旧版「中间段被换只可能把树外数据读进新库」的说法已删除（r2 下子项不再经路径重解析）；`chmodEntry` 已删除；`sha256File`（按路径哈希）已删除，改为内部 `hashFd`。

## §安全复审第 2 轮处置（r3，2026-10-24）

来源：`/tmp/secure-V2-secreview-r2.json`（gpt-6.1-sol 复审：3 Blocker）。按 dev-flow 第三轮由主会话裁定。行号指 r3 的 `src/secure/bin/tree.mjs`（共 2666 行）。

| #   | 复审结论                                                                          | 主会话裁定                                                                                                                                                                              | 处置与落点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 测试                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `rmdirOwned` 的 lstat→rmdir 非原子，换入的空目录会被删                            | **接受的残留**（rmdir 只能删空目录，不丢数据；窗口仅同 uid 定向竞态可用；探针目录是本进程 0700 mkdtemp）；能低成本收紧就做                                                              | 注释与 §9 写明限定，I1 精确表述为「绝不删除非本次创建的数据；唯一残留：同 uid 定向竞态下可能删除被换入的空目录」。收紧：探针中途不再 rmdir（`a` 改为移到从未使用的 `c`）；清理前确认临时目录仍在原名下且父目录 fd 身份未变，否则一律不动；倒序逐个 rmdir，第一次失败即停止并全部报告；rmdir 后确认名字已消失。`probeTreeTools` / `rmdirOwned`：L1929–2032                                                                                                                                                                                                                                                                                                                    | 「#1 probe」（临时目录被移走 ⇒ 什么都不删，`a`/`b` 留在移走的目录里并报告）；「r2-1 probe」（`b` 被放入文件 ⇒ 清理在 `b` 停止，文件完好，`b`/临时目录在 `leftover`）                                                                                                                                                                                      |
| B2  | I4 以 ctime/mtime 判定版本稳定，可碰撞                                            | 所有版本比较必须是纳秒精度 + dev/ino/size；同 tick 碰撞只可能来自并发写入者（占用检查排除良性者，定向竞态在范围外）⇒ 写入残留，I4 表述为「在占用检查成立的前提下」；xattr 名字 ABA 同理 | `sameVersion`（L437–450）改为比较 dev、ino、size、mode、`mtimeNs`、`ctimeNs`（原先缺 size/mtime）；校验读前读后改用 `sameVersion`（L1800）。**纳秒精度证据**：全部 stat 都来自 `lstatBig`/`fstatBig`（`{bigint:true}`），清单条目的 `mtimeNs`/`ctimeNs` 由 `String(st.mtimeNs)` 生成（`entryFromStat`）；版本比较点 = `sameVersion`、`sourceMatches`（L1396，比较 dev/ino/size/type/mtimeNs/ctimeNs）、`compareBaselines` 的 `BASELINE_FIELDS`（L1353，含 size/mtimeNs/ctimeNs/dev/ino/mode/nlink）。`verifyCopy` 里按毫秒比较的 `mtime` 是「目标是否带上了源的 mtime」的元数据核对（Node 只能以秒为单位写时间），不是版本稳定判断。下面 grep 剩余的非 bigint 调用见自验说明 | 原有 #3/#6/#7 回归（ctime/ino 变化被发现）；三连跑稳定                                                                                                                                                                                                                                                                                                    |
| B3  | `groupMembers` 枚举失败返回空、stat 读失败被忽略 ⇒ 当作组空不发 KILL（fail-open） | **真缺陷，必须修**：枚举失败或任何成员 stat 读失败 ⇒ unknown；仍发一次 SIGKILL（仅当 pgid 可证明属于本次 worker）并以 `unclean` 返回；只有完整枚举且确认组空才算干净                    | 新增 `readProcStart`（L2321）、`scanGroup`（L2339，返回 `{complete, members, leader}`：readdir 失败、非「进程已消失」的 stat 读错误、解析失败 ⇒ `complete:false`）、`groupMembers`（L2374，不完整 ⇒ `null`）、`pgidStillOurs`（L2385：组长未回收；或完整扫描有 pgrp 匹配且启动时间不早于组长的存活成员、且没有别的进程占用 pid = pgid）、`reapGroup`（L2397：轮询，可证明归属时发 SIGKILL，只有完整且为空才 `clean`）。`superviseWorker`（L2443 起；组长启动时间与回收状态 L2464，`killGroup` 先证明归属 L2518，清理 L2534）与 `runChild`（L977–1023）都改用 `reapGroup`；`renameNoReplace` 遇到不干净的 mv 收尾 ⇒ `unknown/mv-unclean`（L1079）                             | 「r2-3 scanGroup」（/proc 不可读、stat 是目录、stat 乱码 ⇒ 不完整；正常夹具完整且排除僵尸）；「r2-3 supervisor」两例：/proc 不可读时停滞 ⇒ 仍向未回收的组发 KILL（以子进程 `signalCode === "SIGKILL"` 独立证明）、结果 `unclean/incomplete`；正常结束后 /proc 不可读 ⇒ `unclean`，不返回普通 result；#9 两例的组空断言改为独立的 `kill(-pgid, 0)` ⇒ ESRCH |

## 10. 自验（r3）

见回复尾部（命令与结果原样贴出）。
