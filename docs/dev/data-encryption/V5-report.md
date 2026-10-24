# V5 报告 — `pi-secure export / import` 与迁址事务（`src/secure/bin/archive.mjs`）

依据：`convert-plan.md` r3 §3.2–§3.5、§5、§6、§7.1 archive 行、§8 V5 行与 §8.2、§R1/§R2；安全评审 V5（gpt-6.1-sol，3 Blocker / 6 Major）及主会话裁定，处置见 §10。
依赖：V1 `tar.mjs`（31257b92）、V2 `tree.mjs`（c35b5052，仅新增一行 export，见 §9）、V3 `sessions.mjs`（2b97f87d）、V0 helper 端口（e249fc6d）。
未接线：helper `main` 分派 / USAGE / `init --fix-settings` 入口 / `describeVault` 显示 / `resolveVault` 对 pending·relocate 的拒绝都属 V6。

威胁模型（同 V2 裁定）：包不可信，**包括迁址时解密出来的明文树**（导出方自选口令，库内每个明文名字和链接都是攻击者数据）；同 uid 的定向恶意进程不在范围内。

## 1. 文件

| 文件                                       | 说明                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| `src/secure/bin/archive.mjs`（新，零依赖） | 导出、导入、恢复表、迁址事务、口令验证、事务锁、worker 监督 |
| `src/secure/bin/tree.mjs`（仅追加）        | 末尾追加 `export { pgidStillOurs, reapGroup };`，函数体未改 |
| `tests/secure/archive.test.ts`（新）       | 120 条（含 2 条真 gocryptfs e2e）                           |
| `docs/dev/data-encryption/V5-report.md`    | 本报告                                                      |

## 2. API（V6 接线用）

所有 `cmd*` 返回退出码（不 throw、不 `process.exit`），消息经 `ports.out` / `ports.err` 输出。`ports` 可只传要替换的子集，缺省见 `defaultPorts()`。

| 导出                                                                                                                       | 作用                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `cmdExport({name, file, home?, cwd?}, ports?)`                                                                             | §3.2                                                                                            |
| `cmdImport({file, name, path?, verifyPassword?, home?, cwd?, lockWaitS?}, ports?)`                                         | §3.3（`path` = `--path <挂载点>`）                                                              |
| `cmdImportAbort({name, home?, lockWaitS?}, ports?)` / `cmdImportResume(...)`                                               | 恢复表                                                                                          |
| `relocateVault({name, home?}, ports?)` → `{code, message?, warnings[]}`                                                    | §3.4 受控入口（V6 的 `init <名字> --fix-settings` 直接调用；`import --verify-password` 已在用） |
| `verifyVaultPassword({name, home?}, ports?)`                                                                               | 不需要迁址时的 `--verify-password`：同样的准入 + 裸挂载 + 有界卸载，不写任何东西                |
| `listImportStates(home?)` → `string[]`                                                                                     | `status` 用：`import <名字>: interrupted (<phase>) · --resume\|--abort`                         |
| `vaultEntryState(name, home?)` → `present \| absent \| no-file \| unknown`                                                 | 三态登记查询（§10 B3）                                                                          |
| `acquireTxnLock(name, home?, {waitS?})` → `{release()}`、`txnLockPath`                                                     | 单事务排他锁（§10 B2）                                                                          |
| `scanCipherXattrs(dir, {getfattrBin?, pythonBin?, timeoutMs?, maxEntries?})`                                               | 完整 xattr 扫描（§10 M8）                                                                       |
| `exportLocked(payload, deps?)`                                                                                             | 持锁 worker 内的导出主体（可注入 probe/view/scanXattrs/statfs，供矩阵测试）                     |
| `relocateSessionsAnchored` / `relocateMemoryAnchored` / `relocateSettingsAnchored`                                         | fd 锚定的迁址三步（worker 内运行，§10 B1）                                                      |
| `spawnWorker(op, payload, {lockFile?, stallMs?, termGraceMs?, reapMs?, onProgress?, signal?, env?})`                       | §5 worker 监督（绝不 throw）                                                                    |
| `rollbackImport(state, ports, home)`、`readImportState` / `writeImportState` / `importStatePath` / `txnDir` / `secureRoot` | 状态文件与回滚原语（rollback 的调用方须持事务锁）                                               |
| `AX`（§6 码表）、`BUDGET`、`RELOCATE_PHASES`、`parseGetfattr`、`toFailure`、`defaultPorts`                                 | 常量与小工具                                                                                    |

`defaultPorts()` = `V0_PORTS`（unlockVault / registerVault / patchVaultEntry / removeVaultEntry / finalizeBounded / scanCwdOccupants / preflight）+ `probeMountState` · `vaultInstanceView` · `runWorker`(=spawnWorker) · `txnLock`(=acquireTxnLock) · `isTTY` · `txid`（12 字节 hex）· `now` · `gocryptfsVersion` · `statfsFree` · `onInterrupt`（SIGINT 订阅）· `out` · `err`。

worker 协议：`node archive.mjs __archive-work <op> <json>`（独立进程组，`--max-old-space-size=1024`）；ops = `export`（在 `flock -o -E 73 -w 10 <v.lock>` 下）/ `read` / `relocate-sessions` / `relocate-memory` / `relocate-settings` / `sync`。stdout 每行一个 JSON：`{"p":…}` 进度（≤1 行/秒；导出另发一次 `{"p":{"partial":{dev,ino}}}` 作为 partial 的创建凭证）、`{"ok":…}` 或 `{"err":{code,message,reason?}}` 终结。自入口只认 `__archive-work`，其余参数 exit 2。

## 3. 导出（§3.2）

1. 锁外快检：`resolveVault`（新、旧布局都可）；`vaultEntryState` 必须为 `present`（unknown ⇒ 78）；`pending` ⇒ 76、`relocate` ⇒ 78；目标文件已存在 ⇒ 78（不碰）；输出父目录缺失 ⇒ 66；密文目录或 `gocryptfs.conf` 缺失 ⇒ 78。
2. `flock -o -E 73 -w 10 mount.lock` 下的 worker（`exportLocked`）重新判定：全局 `probeMountState` ≠ `absent` ⇒ 76（stale / hung / foreign 同样）；`vaultInstanceView` 只允许 `none`（租约空闲或无租约的旧布局）与 `stale`，其余 ⇒ 76；`scanCipherXattrs` 发现**任何** xattr ⇒ 65、扫描不完整 ⇒ 74、扫描工具都没有 ⇒ 69；空间 < 密文×1.02+1 MiB ⇒ 74。
3. `<文件>.partial-<txid>`（`O_EXCL|O_NOFOLLOW` 0600），创建后立刻把 fd 的 (dev,ino) 作为凭证上报 → `writePackage` → fsync → `link(partial, 最终名)`（EEXIST ⇒ 78，不覆盖）→ unlink partial → fsync 父目录。任何清理都只在「有凭证且身份仍匹配」时 unlink；`O_EXCL` 撞到已存在的 partial ⇒ 78，不删除；没有凭证的遗留 partial 只报告。
4. SIGINT：abort worker（组 TERM，2 s 后 reapGroup 组 KILL），按凭证删 partial，130；若 link 已完成会如实说明。
5. 只读密文：worker 只遍历/读取 `v.cipher` 与锁/租约元数据；测试在导出期间把挂载点 chmod 000 仍成功。

## 4. 导入事务（§3.3）

**事务锁**：`.txn/import-<名字>.lock`（0600）。持有者是 `flock -x -w 10 <lock> sh -c 'read _'`，stdin 接本进程的管道：释放 = 关管道；本进程崩溃（含 SIGKILL）时管道 EOF，持有者退出，锁随之释放。`import`、`--abort`、`--resume` 都先拿锁（等 10 s 拿不到 ⇒ 73），在锁内重读状态再决策，直到操作结束才释放（import 的自动回滚也在锁内）。

状态文件 `~/.local/share/pi-toolkit-secure/.txn/import-<名字>.json`（0700 目录、0600 文件、tmp+fsync+rename+fsync 目录）：`{v:1, txid, name, phase, pkg, staging, dir, mnt, ids:{staging,dir,mnt}, origRealWork?, createdAt}`。读取时严格校验形状（含本用户、mode 无组/其他位、≤64 KiB），`dir` 必须等于 `defaultVaultDir(name)`、`staging` 必须等于 `<dir 父>/.<名字>.import-<txid>`、`mnt` 必须是规范化绝对路径；`mnt` 还要和登记项绑定（见回滚）。

| phase        | 进入时已完成                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claimed`    | 事务锁到手；登记 `absent`/`no-file`、无状态文件、快检通过；`registerVault(…, {expectAbsent, pending:"import:<txid>"})` 认领成功                                                                        |
| `staging`    | 暂存根独占创建，dev+ino 已记录                                                                                                                                                                         |
| `staged`     | worker `readPackage` 校验通过（V1 的全部包内校验都只写暂存根）                                                                                                                                         |
| `publishing` | 开始发布：建 lock/lease → 独占 `mkdir <dir>`（记 ino）→ 逐项 rename（每步核对暂存与 `<dir>` 身份、目标不存在）→ cipher 根 chmod 0700 → rmdir 暂存 → 独占 `mkdir <mnt>`（记 ino）+ 哨兵 → `checkLayout` |
| `published`  | `sync -f <dir>`（worker）完成                                                                                                                                                                          |
| 提交         | `patchVaultEntry(guard pending=本 txid, remove pending [+ set relocate])`；然后删状态文件、放锁                                                                                                        |

提交前任何失败 ⇒ `rollbackImport`；完全回滚后保留 65/73/75/76/78/130 原码，其余报 74；回滚未完成 ⇒ 74 + 剩余清单 + `import --abort` 提示。worker 进程组未能确认清空（`unclean`）⇒ 不回滚、保留状态、75。

`--verify-password`：先要求 TTY（否则 2，零改动）；提交后**一定**验证口令：需要迁址走 `relocateVault`，不需要迁址走 `verifyVaultPassword`（裸挂载 + 卸载）。77 ⇒ exit 77「包已导入并校验；口令未验证[；迁址仍待完成：pi-secure init <名字> --fix-settings]」；其他失败 ⇒ exit 1。

### 回滚授权（`rollbackImport`，调用方持事务锁）

先重读登记项（三态），只有两种情况可以动手：

- `present`，`pending === "import:<txid>"`，且登记的 `dir`/`mnt` 与状态文件逐字相同——此时 `<mnt>` 由登记佐证；
- `absent`（settings 可读、结构合法、无该条目）——此时只有派生路径（暂存、`<dir>`）和**缺省**挂载点可删，`--path` 指定的挂载点只报告不删。

其余一律不动：`present` 但 pending 已清（已提交）或属于别的事务；dir/mnt 与登记不符；`unknown`（读取失败、JSON 损坏、结构非法、条目非对象）；`no-file`（settings 不存在）。可删的对象还要逐项满足：暂存与 `<dir>` 的 dev+ino 与状态文件一致、`<dir>` 全局未挂载；`<mnt>` dev+ino 一致且只含两个 0 字节哨兵。全部干净后才 `removeVaultEntry(pending=本 txid)`（仅 `present` 时）→ 删状态文件。未记录 ino 的 `<dir>`（mkdir 与写状态之间崩溃，或别人建的）一律不动，只报告。

### 恢复表（`--abort` / `--resume`）

| 实际状态                                         | `--abort`                                       | `--resume`                                      |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------- |
| 仅暂存（ino 一致）                               | 删暂存 + 删本 txid 登记 + 删状态文件，0         | 拒绝（1，未发布）                               |
| `<dir>` ino 一致、部分条目已移入                 | 整体撤销，0                                     | 拒绝（1）                                       |
| 已发布、登记仍带 `pending:"import:<txid>"`       | 撤销，0                                         | 复核登记 dir/mnt + 身份 + 布局 → sync → 提交，0 |
| 已提交（pending 已清，状态文件残留）             | 拒绝（1「导入已提交，不能撤销」），不碰任何东西 | 仅清状态文件，0（有 relocate 时给迁址提示）     |
| 登记 pending 属于别的事务                        | 拒绝（1），不碰                                 | 拒绝（1）                                       |
| 登记读不出 / 结构非法 / settings 不存在          | 78，不碰任何东西                                | 78                                              |
| 状态文件的 mnt 与登记不符                        | 74，不碰任何东西                                | 拒绝（1）                                       |
| 身份不符 / `<mnt>` 有哨兵外条目 / `<dir>` 仍挂载 | 该项保留并列出；登记与状态文件都保留，74        | 拒绝（1）                                       |
| 状态文件损坏或被篡改（dir/staging/形状）         | 78，不做任何事                                  | 78                                              |
| 另一个 import/abort/resume 正持有事务锁          | 等 10 s，仍忙 ⇒ 73                              | 同左                                            |
| 已登记、带 `relocate`                            | —（交给 §3.4：`relocateVault`）                 | —                                               |

## 5. 迁址事务（§3.4，`relocateVault`）

前置：登记项 `present` 且带 `relocate:{from,to,txid,phase}`、无 `pending`；新布局；**非私有库**（私有库须走 V6 的 setup 模式入口，V5 拒绝 78）；全局未挂载（否则 76）；无活动/无法判定的私有实例、租约空闲（否则 76）；`to` 必须等于当前 `<realMnt>/work`（否则 78）。全部在挂载前判定。
挂载：`unlockVault(v,{postMount:false})`；若返回 `how:"already"`（别人抢先挂上）⇒ 76，不写、不卸载。
步骤（每步之前在 settings 锁内以 `relocateTxid` 守卫写入 phase；崩溃后标记停在该 phase，下次入口重做，每步可重入），全部在 worker 内、**fd 锚定**：

- 打开挂载根 `O_DIRECTORY|O_NOFOLLOW`，要求其 `mnt_id`（`/proc/self/fdinfo`）等于 mountinfo 中该路径最顶层挂载的 id 且类型为 `fuse.gocryptfs`；
- 之后每一级（`state`、`sessions`、`default`、`memory`、`work`、`.pi`）都相对父 fd 用 `/proc/self/fd/<fd>/<name>` + `O_DIRECTORY|O_NOFOLLOW` 打开，必须仍在同一 `mnt_id`；符号链接或非目录 ⇒ 65；
- 会话：逐个 `*.jsonl` 以 `O_NOFOLLOW` 打开读取（符号链接/非普通文件 ⇒ 65，单文件 ≤256 MiB），用 V3 纯函数 `relocateSessionContent` 改写，tmp（同目录 fd、`O_EXCL|O_NOFOLLOW`）+ 保留 mode/时间 + fsync + rename；
- memory：`state/memory/<slug(from)>` 必须是真目录（符号链接 ⇒ 65）；目标已存在 ⇒ 不合并、警告；rename 在同一目录 fd 内；
- 项目设置：`work/.pi/settings.json` 的 fd 锚定版 `syncProjectSettings(fix)`（缺目录则在锚定的父 fd 下 mkdir；原文件 `O_NOFOLLOW` 读，有其他 sessionDir 或内容不是 JSON 时先写 `settings.json.bak-<时间>`）；
- `sync -f <realCipher>` → `synced` → 清除 `relocate`（仅本 txid）。

无论成败，本函数挂上的挂载都 `finalizeBounded` 卸载。77 时什么都没改、不卸载。

## 6. 不变量 ↔ 代码 ↔ 测试

| 不变量                                                              | 代码                                                                          | 测试（`tests/secure/archive.test.ts`）                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不可信包先在暂存根校验，通过后才发布                                | `cmdImport` read worker → `publishStaged`                                     | `malicious packages ⇒ 65 …`（语料 60 例，零残留、登记撤销、诱饵不动）；`happy path`                                                                                  |
| 解密后的明文链接绝不跟随（I2/I3）                                   | `anchorVaultRoot` / `openVaultDir` / `readVaultFile` / `writeVaultFileAtomic` | `review B1`：state→外部、work→外部、state/memory→外部、会话文件/slug/`.pi` 为链接、普通目录冒充挂载根；真 gocryptfs `review B1 (real gocryptfs)`（state、work 两种） |
| 回滚只碰本 txid 的产物                                              | `rollbackImport`（三态登记 + dir/mnt 绑定 + ino 比对 + 派生路径）             | `identity mismatch`、`<mnt> with non-sentinel entries`、`row 4 / foreign`、`tampered state file`、`M4` 两条、诱饵目录                                                |
| 同一事务的 import/abort/resume 互斥                                 | `acquireTxnLock`、`openTxn`、`cmdImport`                                      | `B2: abort waits … resume commits`（非等待 abort ⇒ 73；等待的 abort 不删已提交库）、`B2: lock of a SIGKILLed import is released`、`same-name concurrent imports`     |
| 登记状态未知不授权删除                                              | `vaultEntryState`、`rollbackImport` 第 0 步                                   | `B3` 两条（JSON 损坏 / EACCES / settings 缺失；提交后 settings 损坏的失败导入）                                                                                      |
| 任何失败不删除既有用户数据                                          | 快检 + 独占 mkdir（EEXIST ⇒ 78、ids 为 null ⇒ 不动）                          | `refusals before any change`、`racer creates <mnt> during the read`                                                                                                  |
| I-C2 提交后不删除                                                   | `rollbackImport` 第 0 步重读登记                                              | `I-C2: commit landed but its reply was lost`、`row 4`、`B3 commit landed … unreadable`                                                                               |
| 导出只含密文、不读明文                                              | `exportLocked` 只走 `v.cipher`                                                | `real flock + worker`（挂载点 chmod 000）、e2e「包里没有明文字节」                                                                                                   |
| partial 只凭创建凭证删除                                            | `exportLocked` `onCreated`、`removeOwnFile(p, id)`、`cmdExport.cleanup`       | `M5`（预存同名 partial ⇒ 78、内容与 ino 不变）、`SIGINT ⇒ … 130`、`target appears before link`                                                                       |
| §3.5 互斥：已挂载 / 私有实例 / 租约忙 ⇒ 76；pending 76；relocate 78 | `exportLocked` 准入、`cmdExport` 快检、`admitOwnMount`                        | `exportLocked admission matrix`（9 例）、`real lease holder ⇒ 76`、`pre-lock refusals`、e2e「挂载中 76」、迁址后 export 78                                           |
| 迁址只在本函数独占的裸挂载上进行                                    | `admitOwnMount`、`ownRawMount`                                                | `review M7`（私有 78、已挂载 76、私有实例 76、`already` 76；零 worker、不卸载）                                                                                      |
| 导出期间 mount.lock 互斥 ⇒ 73                                       | `spawnWorker` lockFile                                                        | `mount.lock held by another pi-secure ⇒ 73`                                                                                                                          |
| xattr：任何属性拒绝、扫描不完整拒绝                                 | `scanCipherXattrs`、`parseGetfattr`                                           | `M8` 两条（getfattr 非零 74、selinux 计入、python 回退发现属性、python 扫描失败 74、二者皆无 69；真实密文文件带 xattr ⇒ 65）                                         |
| `--verify-password` 一定验证                                        | `cmdImport` 第 8 步、`verifyVaultPassword`                                    | `M9`（MANIFEST 声称同址：错口令 77 且导入保留；正确口令 0，挂载+卸载）、`import --verify-password: 77 …`                                                             |
| 迁址可重入、标记在期间阻断 export                                   | `relocateVault` phase 守卫                                                    | `crash mid-way keeps the marker …`、`raw mount → …`（phase 序列）                                                                                                    |
| 真实崩溃后的恢复                                                    | 状态文件 + 恢复表 + 事务锁                                                    | `row 3`、`B2`、`B3`、`M4`（均为子进程在提交点 SIGKILL）                                                                                                              |
| 有界、进程组杀净（I5）                                              | `spawnWorker` + tree.mjs `reapGroup`                                          | `stall watchdog`、`abort signal`、`M6`（组长 TERM 退出、忽略 TERM 且不持管道的同组后代仍被 KILL）、`stalled read worker ⇒ 75`                                        |
| 端到端真 gocryptfs                                                  | —                                                                             | `round trip`、`review B1 (real gocryptfs)`（假口令 passfile、文件 fd 挂载、共享锁）                                                                                  |

## 7. 预算（§5）

| 项                   | 值                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| worker 停滞看门狗    | 60 s 无进度行 ⇒ 组 SIGTERM；2 s 后 `reapGroup` 组 SIGKILL 并轮询至完整扫描为空，1 s 后放弃 ⇒ 75 |
| 正常结束后           | 同样 `reapGroup`（≤1 s）清掉遗留后代；未能证明清空 ⇒ `unclean`（结果未知，不做破坏性回滚）      |
| mount.lock（导出）   | `flock -w 10` ⇒ 73                                                                              |
| 事务锁               | `flock -w 10` ⇒ 73（崩溃即释放）                                                                |
| settings 锁          | V0 端口内 10 s ⇒ 73                                                                             |
| xattr 扫描 / sync -f | worker 内，各 60 s（spawnSync timeout）且受停滞看门狗约束；python 回退 ≤1 000 000 条目          |
| 迁址单文件           | 会话 ≤256 MiB、项目设置 ≤1 MiB（超出 ⇒ 65）                                                     |
| 进度行               | ≤1 行/秒（只用于活性）                                                                          |
| 空间                 | 导出 ≥ 密文×1.02+1 MiB；导入 ≥ 包×1.05+64 MiB（⇒ 74）                                           |
| 状态文件             | ≤64 KiB，超出视为损坏                                                                           |
| worker 内存          | `--max-old-space-size=1024`                                                                     |
| 卸载                 | V0 `finalizeBounded`（10 s + 0.5 s 硬兜底）                                                     |

## 8. 偏离与残留

1. **worker 入口**：计划写 `node helper.mjs __export` / `__convert-work`；V5 不得改 helper，故 worker 是 `node archive.mjs __archive-work <op>`。
2. **测试接缝**（生产不设置即无影响）：worker 读取 `PI_SECURE_TEST_ARCHIVE_STALL_MS`（op 前静默延迟，上限 600 s）与 `PI_SECURE_TEST_ARCHIVE_ORPHAN_PIDFILE`（op 前派生一个忽略 TERM、不持管道的同组 `sh`，用于 I5 回归）；先例是 helper 的 `PI_SECURE_TEST_WORKER_DELAY`。迁址 op 的 payload 字段 `mountCheck:false` 只供进程内测试替换 `runWorker` 端口时使用（用普通目录冒充挂载），生产代码恒为 `true`，CLI 不可达。
3. **cipher 根目录 mode**：包会恢复导出方的 cipher 根 mode；发布后把**本次移入的** `<dir>/cipher` 根 chmod 0700（满足 `checkLayout`），子项 mode 保留。
4. **`import --abort` 成功返回 0**（评审未再争议）；`--resume` 拒绝返回 1。
5. **SELinux 残留**：按 r3「任何 xattr 拒绝」执行，`security.selinux` 不豁免——在 SELinux 打标签的系统上，导出会因每个密文文件都有标签而一律 65；需要时另行裁定豁免并同步规格。
6. **私有库迁址/口令验证**：V5 直接拒绝（78），V6 在 setup 模式入口提供私有库路径。
7. **`from == to` 的判定**仍以 MANIFEST 的 `origRealWork` 与本机实际 `<realMnt>/work` 比较；它只决定「要不要改写」，`--verify-password` 不再受它影响。MANIFEST 撒谎的后果仅是不改写（会话里留旧路径），不会写到库外。
8. **拒绝路径的元数据**：拿事务锁会在拒绝前创建 `.txn/` 与 `import-<名字>.lock`（同 mount.lock，元数据，不删除）。用法错误与 `--verify-password` 无 TTY 在拿锁前拒绝，零改动。
9. **回滚未完成时登记保留**：只有所有产物都证明已删除后才删登记项；`--abort` 可重试。
10. **`listImportStates` 只给文案**，接入 `status` 属 V6。
11. **SIGINT 期间的 import**：中断 abort 当前 worker 并回滚（130）；监督者本身被 SIGKILL 时状态保留、事务锁随管道 EOF 释放，用 `--abort` 收尾。
12. **测试稳定性**：上一轮 `tests/secure --maxWorkers=3` 三次中首次出现 1 条未保留输出的失败；本轮修复后全量运行 24 文件 1180 条全绿。

## 9. 导入清单（只读使用）

helper.mjs（未修改）：`CliError`、`EXIT`、`V0_PORTS`、`VAULT_NAME_RE`、`checkLayout`、`defaultVaultDir`、`defaultVaultMnt`、`deriveVault`、`homeDir`、`loadSecureConfig`、`mntAncestorProblems`、`physicalPaths`、`positionProblems`、`probeMountState`、`readJsonFile`、`resolveVault`、`settingsFilePath`、`vaultInstanceView`（上一轮的 `syncProjectSettings` 已不再使用，改为 fd 锚定实现）。
tar.mjs（未修改）：`PkgError`、`discardStaging`、`readPackage`、`scanCipherTree`、`writePackage`。
sessions.mjs（未修改）：`memorySlug`、`relocateSessionContent`（纯函数）、`stateSessionsDirFor`（不再使用按路径读写的 `relocateSessionsInDir` / `relocateMemoryDir`）。
tree.mjs：`mntIdOf`、`readProcStart`、`reapGroup`。为此在 tree.mjs **末尾仅追加**一行 `export { pgidStillOurs, reapGroup };`（原本未导出的两个函数，函数体与其他行均未改动；`pgidStillOurs` 供 `reapGroup` 内部使用，一并导出以便将来复用）。

## 10. 安全评审处置（V5，gpt-6.1-sol：3 Blocker / 6 Major）

| #   | 严重度  | 问题                                                           | 处置                                                                                                                                                                                                                                                                                                                                     | 测试                                                     |
| --- | ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| B1  | Blocker | 迁址跟随解密后由包控制的 work/state 中间链接，可读写库外       | 迁址三步改为 worker 内 fd 锚定实现：挂载根 `O_NOFOLLOW` 打开并以 `mnt_id` 证明是本库 `fuse.gocryptfs` 顶层挂载；之后逐级 `/proc/self/fd/<fd>/<name>` + `O_DIRECTORY\|O_NOFOLLOW`，同一 `mnt_id`；会话/设置文件 `O_NOFOLLOW` 读、同目录 fd 内 `O_EXCL` tmp + rename；任何链接或非目录中间组件 ⇒ 65。不再调用按路径工作的 V3/helper 写函数 | `review B1` 5 条 + 真 gocryptfs 1 条（state、work 两种） |
| B2  | Blocker | import/abort/resume 无同事务互斥，abort 可删 resume 刚提交的库 | 每事务一把 `.txn/import-<名字>.lock` flock（管道持有，崩溃即释放），import/abort/resume 全程持锁，锁内重读状态与登记后再决策；拿不到 ⇒ 73                                                                                                                                                                                                | `B2` 两条                                                |
| B3  | Blocker | 登记读取失败/非法/缺失被折叠为「可删」                         | `vaultEntryState` 四态；只有 `present`+本 txid pending（且 dir/mnt 一致）或可证明 `absent` 才授权；`unknown`/`no-file` ⇒ 保留一切，abort/resume 78、import 失败回滚报剩余项                                                                                                                                                              | `B3` 两条                                                |
| M4  | Major   | 状态文件的 mnt 及身份未与登记绑定                              | 回滚与 resume 要求登记的 dir/mnt 与状态文件逐字相同；登记可证明缺失时只删缺省挂载点，`--path` 挂载点只报告；状态文件还要求本用户、无组/其他权限位、mnt 规范化                                                                                                                                                                            | `M4` 两条                                                |
| M5  | Major   | partial 删除无所有权凭证                                       | worker 在 `O_EXCL` 创建后上报 fd 的 (dev,ino)；所有删除都要求该凭证且身份仍匹配；EEXIST 无凭证 ⇒ 不删；无凭证的遗留只报告                                                                                                                                                                                                                | `M5`、`SIGINT`                                           |
| M6  | Major   | 组长 TERM 后退出会取消组 KILL                                  | 复用 tree.mjs 已评审的 `reapGroup`（含 `pgidStillOurs`、完整 /proc 扫描）；升级后由独立的 ref'd 定时器在 2 s 后执行组 KILL 与轮询，组长 close 不能取消；正常结束同样清组；不能证明清空 ⇒ `unclean`（75，不回滚）                                                                                                                         | `M6`                                                     |
| M7  | Major   | relocateVault 不拒绝私有库或已有挂载                           | `admitOwnMount`：私有库 78、全局已挂载 76、私有实例/租约忙 76；`unlockVault` 返回 `already` ⇒ 76，不写不卸载                                                                                                                                                                                                                             | `review M7`                                              |
| M8  | Major   | getfattr 非零退出当作无 xattr；静默忽略 security.selinux       | getfattr 只有 exit 0 才算扫描完成（非零/信号/超时/溢出 ⇒ 74）；不再豁免任何属性；getfattr 缺失 ⇒ `python3 -I -c` 的 `os.listxattr`（不跟随链接、有界、argv 传参）；二者皆无 ⇒ 69 并提示安装 attr                                                                                                                                         | `M8` 两条                                                |
| M9  | Major   | 同址时 `--verify-password` 被跳过                              | 拆开「要不要迁址」与「要不要验证」：显式 `--verify-password` 一定挂载验证（无迁址走 `verifyVaultPassword`），同址短路只省掉改写                                                                                                                                                                                                          | `M9`                                                     |
