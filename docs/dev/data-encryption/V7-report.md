# V7 报告：启动器 e2e + conformance + todo #31

> 范围：convert-plan r3/r3.1 §7.2（启动器 e2e：真 gocryptfs、真 `pi-secure` 启动器、假 pi）、§7.3（XC1–XC9）、§8 的 V7 行，外加 todo #31（gocryptfs 测试锁随测试进程释放）。
> 纪律：零 git 操作、未提交；真实 gocryptfs 只在 mktemp 里用假口令（`TESTPASS-fake-not-a-secret`）；不碰真实 `~/secure` 与 `~/.pi`；清理只动本轮 token 标记的目录与可证明属于本轮的进程。

## 1. 改动文件

| 文件                                                                                                       | 性质                 | 说明                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tests/secure/launcher-convert.test.ts`                                                                    | 新                   | §7.2 启动器 e2e，42 例（含 §10 安全评审新增的 5 例，自门控）                                                                      |
| `tests/conformance/secure-convert.test.ts`                                                                 | 新                   | XC4–XC7 + 全部 XC 行的索引（自门控）                                                                                              |
| `tests/secure/gocryptfs-test-lock.test.ts`                                                                 | 新                   | #31 验收（含 §10 m1），5 例                                                                                                       |
| `tests/secure/gocryptfs-test-lock.ts`                                                                      | 改                   | #31：持锁者改为随测试进程消亡的小 watcher（§4、§10 m1）                                                                           |
| `tests/secure/private-real-harness.ts`                                                                     | 改（仅追加可选参数） | `setup()` 增加 `{acme, root, prefix}`，`tmp()` 增加 `root`，`tty()` 增加 `{answers, cwd, password}`；默认值下行为与原来逐字节相同 |
| `tests/conformance/secure-convert-xc2.test.ts`、`secure-convert-xc89.test.ts`                              | 改（只改头注释）     | 「V7 folds this into …」改为「V7 决定保留」                                                                                       |
| `src/secure/bin/convert.mjs`                                                                               | 改                   | STOP 测试缝（§5）；§10 M1 门控、M2 证据过期复核                                                                                   |
| `src/secure/bin/helper.mjs`、`src/secure/bin/archive.mjs`                                                  | 改                   | §10 M1：测试缝门控、警告、`status` 的 warn 行                                                                                     |
| `tests/secure/convert-state.test.ts`                                                                       | 改（追加）           | §10 M2 单测 7 例                                                                                                                  |
| `tests/secure/archive.test.ts`、`launcher-private.test.ts`、`launcher-fuse.test.ts`、`convert-fixtures.ts` | 改                   | §10 M1：使用测试缝的地方同时设置 `PI_SECURE_TEST_SEAMS=1`                                                                         |

## 2. §7.2 覆盖矩阵（`tests/secure/launcher-convert.test.ts`）

全部用例都经 `pi-secure` bash 入口运行：bash → helper.mjs → convert/archive 引擎 → 各自的 worker，用的是真 gocryptfs。交互走 script(1) 伪终端，口令、保险库名确认和 `继续？[y/N]` 都按提示键入。

| §7.2 条目            | 用例                                                                                                                                                                                                                                                                                                                                                                                                                       | 关键断言（含铁律）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 convert 往返       | `§7.2-1/2 convert round trip …`                                                                                                                                                                                                                                                                                                                                                                                            | 夹具：git 仓库（2 次提交、已修改、未跟踪）、`.bin` 符号链接、硬链接组、子目录、空目录、只读文件/目录、200 字节长文件名。确认 1 次，口令提示 3 次（init ×2 + 挂载），master key 打印 1 次。原路径是指向 `<mnt>/work` 的符号链接。**备份无任何写位**，去掉写位后与对照逐项一致。锁定时 `cd` 原路径失败。没有挂载、没有 `.txn/convert-proj*`。登记为 `{dir,mnt,origin,backup}`。`status` 显示 `backup: … (still present)` 和 `origin:`。保险库内与对照逐项一致，只允许 `.pi/settings.json`（+`.bak-*`）不同，work 根目录本身是保险库的 0700 目录（V4 第 7 步 `applyRootMeta:false`）。`sessionDir` 已写好；`git rev-parse HEAD` 一致，`status --porcelain` 只多 `?? .pi/`，`git fsck` 通过                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2 会话               | 同上                                                                                                                                                                                                                                                                                                                                                                                                                       | 根会话、子 agent 会话（parentSession + subagent:run）、子目录会话、**worktree 子会话**（cwd 在树外，只能经闭包到达）、无关会话。用真 pi `SessionManager.list` 检查：work 列出 root+child，work/sub 列出 sub。worktree 副本的头部 cwd 保持不变，根副本里的引用已改指副本。无关会话不复制。memory 复制到新 slug。**旧会话与 memory 的字节、mtime、inode 全部不变**，完成输出列出旧路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3 回滚               | `§7.2-3 fail seam at step %i:%s`（第 2–14 步各一个，共 13 例）；`§7.2-3 the step-11 barrier fails (sync -f …)`                                                                                                                                                                                                                                                                                                             | 退出 74，输出「已回滚」。源目录回到原路径，与对照逐项一致**（mode 也一致）**；没有备份、没有登记、没有状态文件、没有挂载。新库与挂载点**改名为 `.aborted-<txid>`，从不删除**。旧会话与 memory 不变。第 11 步屏障失败用 PATH 上的假 `sync`（遇到 `-f` 就退出 1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4 中断恢复           | `§7.2-4 kill -9 at 3:mid (renaming)`、`7:before (backed-up)`、`at synced`、`at linked`、`after the commit`、`rollback while the new vault is busy`、`without a TTY and without --assume-unreadable-idle`                                                                                                                                                                                                                   | 用 STOP 缝让编排进程停在指定阶段再 SIGKILL，即精确阶段上的 kill -9。`status` 显示 `convert proj: interrupted (<phase>)` 和 `pending: convert:`。renaming/backed-up：`--resume` ⇒ 76，`--abort` ⇒ 1，源恢复，库改名保留，`status` 出现 `aborted:` 行。synced：交互式 `--resume`（不带 flag，按提示答 y）⇒ 0，链接与提交完成，之后 `--abort` ⇒ 66。linked：`--abort` 删除我们自己建的链接，然后回滚。提交后：`--abort` ⇒ 76「不能撤销」，`--resume` 只做清理。库仍挂载且被占用：第一次 `--abort` ⇒ 74「回滚不完整」「新库仍挂载」，**源已先恢复**，库和状态文件都保留；占用解除后再 `--abort` ⇒ 1。无 TTY 又不带 `--assume-unreadable-idle` ⇒ 75（本机有不可读的同 uid 进程：sd-pam、sshd），且什么都没回滚                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5 备份被改动         | `§7.2-5 backup modified before step 12 …`                                                                                                                                                                                                                                                                                                                                                                                  | 停在 12:before，对备份里的文件 `chmod u+w` 后写入，再 SIGCONT。结果 74「备份在转换期间被改动」，回滚后源目录里**保留这次写入**，其余与对照一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6 拒绝               | `§7.2-6 refusals before any change …`、`a mount inside the tree ⇒ 65; a POSIX ACL ⇒ 65`、`the backup name is taken right before the rename`、`getfattr missing ⇒ 69`                                                                                                                                                                                                                                                       | 无 TTY ⇒ 2。源被占用 ⇒ 76。逃逸相对链接、setgid 目录、user xattr、alternates 指向树外、`$HOME/.config` 下的源、树内挂载、POSIX ACL（以原始 `system.posix_acl_access` xattr 写入，不依赖 setfacl）均 ⇒ 65。缺 getfattr ⇒ 69。每一例都在**任何口令提示之前**拒绝；源 snapshot 不变，没有备份、没有登记、没有库目录。把问题逐个移除后，同一棵树能正常转换（证明这些拒绝就是唯一的阻碍）。备份名被占：停在 3:before，从计划输出里读出备份名并建同名空目录，`mv -n -T` 退出 0 但没有移动，按事后身份判为失败 ⇒ 65，空目录未被替换，源原样                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7 原路径在窗口内被占 | `§7.2-7 original path re-created between steps 12 and 13 …`                                                                                                                                                                                                                                                                                                                                                                | 停在 12:after，在原路径建目录并放入文件，再 SIGCONT。结果 76，不覆盖，状态停在 synced，`status` 显示中断。移除该目录后 `--resume` ⇒ 0，链接建成，备份与对照一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8 export→import      | `§7.2-8 export → import --verify-password`、`import without --verify-password ⇒ run 78; init --fix-settings …; --path`、`private vault: … init --fix-settings relocates inside the private namespace`、`export refusals: mounted ⇒ 76; unlock during a stalled export ⇒ 73`、`wrong password 3× ⇒ 77 …`、`relocation crashing midway …`、`import interrupted: … staged`、`import interrupted during the post-publish sync` | 导出：`tar -tf` 能列出包，含 MANIFEST 与 conf。`--verify-password` ⇒ 0，内容逐项一致（含硬链接组、符号链接、长文件名；mtime 允许 1 µs 误差，见 §7），会话头部已迁址，`run` 正常，源库不受影响。不带 `--verify-password`：`--path` 生效，登记带 `relocate.phase=pending`，`status` 显示 `relocate: pending (pending)`，`run` 与 `export` ⇒ 78；`init --fix-settings` 之后 `run` ⇒ 0。**私有库**：导入后把登记改为 private，`init --fix-settings` 在私有命名空间内迁址 ⇒ 0，没有全局挂载。已挂载时导出 ⇒ 76，且不产生文件。导出卡在 mount.lock 上时，并发 `unlock` ⇒ 73，导出照常完成，没有残留 `.partial-`。口令连错 3 次 ⇒ 77，正好 3 次 `Password:`，导入本身已提交并保留，迁址仍 pending，换正确口令后 `--fix-settings` 完成。迁址在 sessions 阶段被 kill -9 ⇒ `status` 显示 `relocate: pending (sessions)`，`run`/`export` ⇒ 78，再次 `--fix-settings` 续完。导入停在 staging 被 kill：`status` 显示中断，`--resume` ⇒ 1，`--abort` ⇒ 0，只清本次导入的产物，包文件不动。导入在发布后的 sync 阶段被 kill：`run` ⇒ 76，`--resume` ⇒ 1（「尚未发布完成」），`--abort` ⇒ 0 撤销整次导入，然后重新导入成功 |
| 9 恶意语料           | `§7.2-9 every malicious corpus package via the launcher …`                                                                                                                                                                                                                                                                                                                                                                 | 语料生成器里除 ok 与需注入预算之外的全部用例（>150 个）逐个经启动器导入，全部 65。share 根和 `~/secure` 的目录清单不变，登记不变，`.txn` 里没有残留 json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`status` 输出、错误码（0/1/2/65/66/69/73/74/75/76/77/78）在上表中都有直接断言。

## 3. §7.3 conformance：整合决定

**决定：保留** `secure-convert-xc2.test.ts`（XC1/XC2/XC3）和 `secure-convert-xc89.test.ts`（XC8/XC9），只把头注释改为「V7 决定保留」。理由：这两份是 V1 冻结包格式、V2 开工之前的前置闸门，V1/V2 报告引用它们作为证据链，合并会打断这条引用。新文件 `tests/conformance/secure-convert.test.ts` 承载其余各行，并在头注释里给出全部 XC 行 → 文件的索引。

| #   | 文件 / 用例                                                                                                                                                          | 本机结果                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XC1 | xc2 `XC1: plaintext mode bits … stored as the cipher's own mode/mtime`                                                                                               | 通过                                                                                                                                                                                                                                                                         |
| XC2 | xc2 全块（密文表示 + 包往返）                                                                                                                                        | 通过                                                                                                                                                                                                                                                                         |
| XC3 | xc2 `XC3: init writes the strict conf shape …`                                                                                                                       | 通过                                                                                                                                                                                                                                                                         |
| XC4 | `XC4: unmounted, mount.lock held by the export, lease free ⇒ the cipher tree is identical before and after`                                                          | 通过：导出 worker 运行期间断言 mount.lock 被持有、租约空闲、未挂载；导出前后密文树的 type/mode/mtime(ns)/nlink/size/sha/target 逐项相同，mount.lock 的 ino/size/mtime 不变                                                                                                   |
| XC5 | `XC5: GNU tar lists every member …`                                                                                                                                  | 通过：`tar -tvf` 成功；每个目录都是成员；每个硬链接组恰好 1 个文件成员；没有 tar 链接成员（l/h）。GNU tar 用同一密文重新打包：pax 方言在 PaxHeaders 名字处就被拒；ustar 方言通过了 tar 层，因缺 MANIFEST 被拒。两者都是 65，登记不变                                         |
| XC6 | `header rule: our mirror and pi's discovery agree …`、`a custom sessionDir is filtered by EXACT header cwd …`、`open() never rewrites a current-version (v3) file …` | 通过：8 种头部语料上我们的读取与 pi 的 `findMostRecentSession` 结论一致；`SessionManager.list` 与 `continueRecent` 在自定义 sessionDir 下只按精确 cwd 匹配（不含子目录、`-2` 兄弟、父目录）；`open` 一个 v3 文件后字节、mtime、ino 都不变，v1 文件则会被迁移重写（作为对照） |
| XC7 | `system.posix_acl_access … reported`、`security.capability …`                                                                                                        | **本机跳过**：没有安装 attr 的 getfattr。已写好，装上 attr 即自动运行；capability 在 user namespace 中用 `setcap` 设置，设置不了则只跳过该断言                                                                                                                               |
| XC8 | xc89 `XC8 mv -n -T` 块                                                                                                                                               | 通过                                                                                                                                                                                                                                                                         |
| XC9 | xc89 `XC9 gocryptfs write-through + sync -f` 块                                                                                                                      | 通过                                                                                                                                                                                                                                                                         |

## 4. todo #31：测试锁随测试进程释放

**实测**：最初按「锁放在 node 自己持有的 fd 上」实现（node 打开锁文件，`flock -x 3` 继承该 fd，加锁后立即退出）。测试进程本身被 kill -9 时，锁确实立即释放。但对**vitest 主进程**执行 SIGKILL 时，它的 fork worker（`node (vitest 1)`）会变成 ppid=1 的孤儿继续跑当前用例，锁也就继续被占（实测约 5 s，直到用例跑完）。所以这个方案不满足「kill -9 vitest 进程后锁立即可得」。

**最终选择**：锁只由一个小 watcher 持有，watcher 随测试进程消亡。

- node 打开锁文件，作为 fd 3 交给 watcher 后**立即关闭自己那份**，打开文件描述（flock 挂在它上面）只剩 watcher 一个持有者。
- watcher 是 `setpriv --pdeathsig KILL -- sh -c '…'`（本机有 util-linux setpriv）：测试进程一死，内核立即 SIGKILL 它。
- 它还每 50 ms 检查一次测试进程**和测试进程的父进程**（forks 池下即 vitest 主进程）是否存活。检查方式是读 `/proc/<pid>/status`，不用 `kill -0`：父进程属于别的 uid（例如 pid 1）时 `kill -0` 会因 EPERM 误判；僵尸进程视为已死。
- 它派生的 `sleep` 子进程都关闭了 fd 3（`3>&-`），任何孙进程都拿不住锁。
- 不 detach，和测试进程同属一个进程组；`release()` 直接 SIGKILL 它。

**验收**（`tests/secure/gocryptfs-test-lock.test.ts`，4 例）：

1. 进程内：排他、有界等待、release 幂等。
2. 测试进程被 SIGKILL ⇒ 锁在 500 ms 内可得（实测几十 ms），之后没有任何进程打开锁文件。持锁者正好一个（watcher），父进程是测试进程本身。
3. **「vitest 主进程」被 SIGKILL 而 worker 继续活着** ⇒ 锁在 500 ms 内可得，此时孤儿 worker 仍然存在，但已无人持锁。
4. 钉住模块里不再有 detached 的长期持锁者。

手工复核（真 vitest）：后台跑 `vitest run tests/secure/launcher-convert.test.ts -t §7.2-1/2`，等锁被占后 `kill -9 <vitest 主进程>`：**56 ms** 后 `flock -n` 成功（旧实现要 5 s）。残留：孤儿 worker 是 vitest 自己的行为，它会跑完当前用例（含该用例的 token 清理）后闲置；手工复核产生的两个孤儿 worker 已由我按 pid 确认后杀掉。

## 5. 实现修正

e2e **没有暴露需要修复的实现缺陷**，`src/` 下唯一的改动是一个**测试缝**。它会进安全评审，所以逐条列出：

- `src/secure/bin/convert.mjs`
  - 1574 `parseStopAt(env)`：解析 `PI_SECURE_TEST_CONVERT_STOP_AT=<step>:<before|mid|after>`，非法或未设置时为 undefined。
  - 1581 `stopPoint(ctx, step, when)`：命中时 `process.kill(process.pid, "SIGSTOP")`。
  - 1615 `defaultConvertContext` 新增 `stopAt: parseStopAt(env)`。
  - 2361 `failPoint` 第一行调用 `stopPoint`。
  - 2761 新增唯一的 `mid` 点：第 3 步写入 `phase:"renaming"` 之后、改名之前。
- 性质（**已被 V7 安全评审修正，见 §10**）：原文写「只能让流程延迟，不改变任何判定」，这一说法不成立——暂停期间持有转换锁与明文挂载，且暂停若落在最终备份复核之后，续跑时会沿用已过期的证据。§10 M1 给它加了门控，M2 堵上了证据过期的窗口。测试随后要么 SIGKILL（等于在精确阶段 kill -9），要么改变环境后 SIGCONT（精确时点的竞态）。没设置时没有任何效果。先例与 `PI_SECURE_TEST_CONVERT_FAIL_AT`（只能让流程失败）、`PI_SECURE_TEST_ARCHIVE_STALL_MS`（只能延迟）相同。没有新增可以放宽检查的缝：convert 的系统目录规则、挂载点祖先规则都没有加覆盖开关，e2e 是通过把 HOME 和挂载点放到合规位置来满足它们的（§6）。

## 6. 测试环境的取舍（未放宽任何产品检查）

- 源目录必须严格位于 `$HOME` 之下，且不在 SYSTEM_DIRS（`/tmp`、`/var`…）内。所以 convert 用例的临时 HOME 放在仓库内被 gitignore 的 `node_modules/.cache/v7/<mktemp>` 下；该目录在 afterAll 中为空时删除。
- 挂载点的每一级祖先都必须属于本用户或 root、且不可被组/其他写（除非是 root 所有且带 sticky 位）。所以 convert 用例用 `--path` 把挂载点放到 `/tmp/<mktemp>/proj`（/tmp 为 root 所有且带 sticky 位）。export/import 用例沿用 RealHarness 默认的 `/tmp` 根，缺省 `~/secure/<名字>` 在那里合规。
- getfattr：本机未安装。e2e 在启动器 PATH 最前面放一个 python3 替身（`os.listxattr`，输出格式与 `getfattr -h -d -m - --absolute-names [-R]` 相同），**只在真 getfattr 缺失时才放**。「缺 getfattr ⇒ 69」用例也只在这种机器上运行。真工具的输出由 XC7 钉住（本机跳过）。
- 清理：每个用例都持有跨套件 gocryptfs 锁（**按用例而不是整个文件持有**，免得其他真实挂载套件超出各自的等待预算），用例结束时先执行 `T.cleanup()`（杀 token 所属进程、懒卸载本轮 scratch 下的挂载、删除 scratch），再释放锁。

## 7. 观察与待裁定（未改动）

1. **73 文案与 G2 不一致（需裁定）**：plan §7.5 G2 要求 `unlock` 等 mount.lock 超时时的 73 文案统一为「挂载、卸载或导出」，并在 N0 生成前定稿。但实际 helper.mjs 2255/4821（以及 finalize 1669）仍是「另一个 pi-secure 正在挂载或卸载」，而冻结的 N0 golden（`tests/fixtures/secure-launcher-off-golden.json:185`）钉住的正是这一句。改文案就必须重生成冻结面，所以没有动。e2e 断言的是当前文案，并留了注释指向本条。
2. **本机 `$HOME` 曾是 0775（用户已于 2026-10-24 改为 0755）**：按 §L.1 挂载点祖先规则，任何以 `/home/bluecake/...` 为祖先的挂载点（包括缺省的 `~/secure/<名字>`）都会被拒绝：init/convert/import 报 78「挂载点祖先目录检查失败」，unlock/run 报「布局校验失败」。这是有意的安全规则，不是缺陷。但这意味着用户在本机上用新布局前需要先 `chmod g-w ~`，或用 `--path` 把挂载点放到祖先合规的位置。旧布局 demo 库跳过此检查，所以目前 `status` 正常。
3. convert 的挂载点祖先检查在第 2 步 `createLayout` 时才做，晚于确认与认领。失败时能干净回滚（e2e 实测：撤销登记、源原样），但如果放进第 0 步预检，用户不必先输入确认。属于体验建议，未改。
4. 导入在「发布完成、sync 尚未完成」时被中断：状态停在 `publishing`，`--resume` 拒绝（1），只能 `--abort`。这符合 V5 的保守设计：只有 sync 完成后才写 `published`。恢复表里「已发布 ⇒ --resume 提交」那一行只能在 sync 结束与提交之间的毫秒级窗口里到达，e2e 不覆盖，由 archive.test 恢复表单测覆盖。
5. 导入恢复的 mtime 有亚微秒误差：包内是纳秒精度，但写回走 Node 的 `utimes`（以秒为单位的 double，在当前纪元下分辨率约 0.25 µs），e2e 按 1 µs 比较。

## 8. 残留

- XC7 本机未运行（缺 attr 的 getfattr）。convert/export 的 xattr 检测在 e2e 中走 python 替身；真 getfattr 的行为由 XC7 与 convert-preflight 的输出解析单测共同覆盖。
- §7.2-8「迁址中途崩溃」只覆盖了 `sessions` 阶段被 kill；memory/settings 阶段的重入由 archive.test 单测覆盖。
- vitest 主进程被 kill -9 后，孤儿 worker 会继续跑完当前用例（vitest 自身行为）。锁已立即释放，但那个孤儿用例此时是在**不持锁**的情况下继续运行，若恰好与新一轮的私有套件并发，可能让后者偶发失败。
- 时长：`tests/secure` 全量从约 235 s 增加到约 447 s（maxWorkers=3）。主要是本文件（真挂载、按用例持锁，墙钟约 405 s，其中含等锁时间）。

## 9. 自验

见交付消息里贴的尾部：`npx vitest run tests/secure --maxWorkers=3`、`npx vitest run tests/conformance/secure-*.test.ts` ×2、`npm run typecheck`、`sh -n src/secure/bin/pi-secure`、prettier、`pi-secure status`、`grep gocryptfs /proc/self/mountinfo`、`pgrep -af 'sleep 3600'`。

新测试单文件耗时（单独运行，不等锁）：

| 文件                                       | 用例                   | 耗时                                                               |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `tests/secure/launcher-convert.test.ts`    | 37                     | 约 213 s（单独运行）；全量并发时墙钟约 405 s（含等锁）             |
| `tests/conformance/secure-convert.test.ts` | 7（本机 XC7 两例跳过） | 约 2.7 s（单独运行）；与其他 conformance 一起跑时约 38 s（含等锁） |
| `tests/secure/gocryptfs-test-lock.test.ts` | 4                      | 约 1.7 s                                                           |

## 10. 安全评审处置（gpt：0 Blocker / 2 Major / 1 Minor，`/tmp/secure-V7-secreview.json`；主会话裁定）

### M1 测试缝在生产中无门控 → 一律经 `PI_SECURE_TEST_SEAMS=1` 门控

规则：每个 `PI_SECURE_TEST_*` 缝**只有在同时设置 `PI_SECURE_TEST_SEAMS=1` 时才生效**（只有测试会设，而且只设在它派生的子进程环境里）。只设其中一个 ⇒ 该缝被完全忽略，并且每条面向用户的启动器命令都在 stderr 打一行警告。两个都设 ⇒ STOP 缝在 convert 启动时（取锁、提示、写状态之前）打一行醒目警告，暂停前再打一行 step/when/pid。这个门控不是针对同 uid 的安全凭证，只防止误设或继承来的变量改变真实运行。

| 位置                                   | 改动                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `helper.mjs:1693–1716`                 | `TEST_SEAMS_GATE`、`testSeam(name, env)`（变量有值 ∧ 门控为 `1` 才返回值）、`testSeamNames`、`testSeamWarnings`。三种警告：「检测到测试用环境变量 X、Y，已忽略（测试缝只在 PI_SECURE_TEST_SEAMS=1 时生效）」/「检测到测试用环境变量 PI_SECURE_TEST_SEAMS，已忽略（没有设置任何测试缝）」/「测试缝已启用（仅供测试，切勿用于真实数据）：X」 |
| `helper.mjs:5853`                      | `main` 对每条非 `__*` 命令输出上述警告到 stderr。内部入口不输出，它们的 stderr 归上层启动器                                                                                                                                                                                                                                                |
| `helper.mjs:2757–2764`                 | `status`：只要存在任一测试变量（含门控本身）就追加 `warn: 测试用环境变量已设置：…（测试缝已启用｜已忽略）——真实使用时请 unset`。没有这些变量时输出与原来逐字节相同                                                                                                                                                                         |
| `helper.mjs:1720 / 1733 / 1737 / 2102` | `PI_SECURE_TEST_SCAN_DELAY_MS`、`PI_SECURE_TEST_WORKER_DELAY`、`PI_SECURE_TEST_FINALIZE_STALL_MS`、`PI_SECURE_TEST_MOUNT_VERIFY_FAIL` 改走 `testSeam`                                                                                                                                                                                      |
| `archive.mjs:991–995 / 1008 / 1014`    | 同一规则的镜像 `testSeam`（convert/archive 不 import helper）；`PI_SECURE_TEST_ARCHIVE_ORPHAN_PIDFILE`、`PI_SECURE_TEST_ARCHIVE_STALL_MS` 改走它                                                                                                                                                                                           |
| `convert.mjs:1560–1564 / 1568 / 1585`  | 镜像 `testSeam`；`PI_SECURE_TEST_CONVERT_FAIL_AT`、`PI_SECURE_TEST_CONVERT_STOP_AT` 改走它                                                                                                                                                                                                                                                 |
| `convert.mjs:2410–2414`                | STOP 已启用 ⇒ `cmdConvert` 第一件事输出「!!! 测试缝已启用：convert 将在第 N 步（when）暂停（…，仅供测试）」                                                                                                                                                                                                                                |
| `convert.mjs:1591–1597`                | `stopPoint` 暂停前输出「测试缝：convert 在第 N 步（when）暂停（pid P）」                                                                                                                                                                                                                                                                   |

**测试缝清单**（`grep -rn PI_SECURE_TEST_ src/secure`，全部纳入门控）：`SCAN_DELAY_MS`、`WORKER_DELAY`、`FINALIZE_STALL_MS`、`MOUNT_VERIFY_FAIL`（helper）；`ARCHIVE_ORPHAN_PIDFILE`、`ARCHIVE_STALL_MS`（archive）；`CONVERT_FAIL_AT`、`CONVERT_STOP_AT`（convert）。共 8 个。

测试侧：所有使用缝的地方都同时设置了门控——`launcher-convert`、`launcher-private`、`launcher-fuse`、`archive.test`、`convert-fixtures`（`failAt` 时设门控，否则删除）、conformance `secure-convert`。新增 e2e：

- 「M1: STOP/FAIL seams WITHOUT PI_SECURE_TEST_SEAMS=1 are ignored with a warning」：只设 STOP 与 FAIL ⇒ convert 正常完成（0）、出现忽略警告、不暂停、不注入失败。
- 「M1: the gate alone warns; status warns whenever any test variable is present」：无变量 ⇒ 没有任何「测试」字样；只设门控、只设缝、两者都设，三种情况的 stderr 警告与 `status` 的 `warn:` 行都按上表输出。

### M2 最终备份复核之后的暂停 → 不可逆点之前按时间重新复核

`convert.mjs:3009–3037`：

- `STALE_EVIDENCE_MS = 5_000`。
- `evidenceStamp()` 同时记录单调时钟与墙钟。
- `evidenceStale()`：任一时钟间隔超过 5 s，或墙钟回拨超过 1 s，即判为过期。系统休眠时 CLOCK_MONOTONIC 不走而墙钟会走，所以两个时钟都看。
- `refreshIfStale()`：过期就输出一行「距上次备份复核已超过 5 秒（暂停/休眠？），第 N 步之前重新复核备份 …」，然后完整重跑 `reverifyBackup`（占用扫描 + 与 `.base` 比较，口径同第 12 步）。

`reverifyBackup` 结束时记下证据时间（`convert.mjs:3051`）。

为什么是 5 秒：从第 12 步结束到第 13/14 步之间没有用户交互，也没有与数据量成比例的工作，正常只需毫秒级。5 s 比这高出三个数量级，健康运行时永不触发；而任何人能察觉的暂停（Ctrl+Z、休眠、调度停顿、调试器）都会被捕获。误触发的代价只是多花一次复核时间。

接入点：

- 正向流程：第 13 步 `linkOrigin` 之前（`convert.mjs:3004`，位于 `failPoint(13,"before")` 之后）；第 14 步提交之前（`convert.mjs:2632`，位于 `failPoint(14,"before")` 之后、`intr.deferred` 之前）。复核不一致时走既有失败路径：抛出后进入 R-B 回滚，第 14 步时先由 R-B 1 删除本次建的链接，退出 74，**绝不报成功**。
- `--resume`：同样的两个点（`convert.mjs:3169 / 3173`）。不一致 ⇒ 76「请执行 --abort」，不提交；第 14 步前被拒时状态停在 linked，之后 `--abort` 能正常恢复。

各暂停点逐个说明：

| 暂停点                             | 覆盖情况                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `12:after`、`13:before`            | 由第 13 步前的检查覆盖（检查放在 `failPoint(13,"before")` 之后）                                   |
| `13:after`、`14:before`            | 由第 14 步前的检查覆盖（检查放在 `failPoint(14,"before")` 之后）                                   |
| `14:after`                         | 已提交，之后只做收尾（删状态文件、卸载、打印），不再依赖备份证据，不在范围内                       |
| `0:*`–`11:*`、`12:before`、`3:mid` | 在最终复核之前：第 12 步自身的占用扫描 + 纳秒精度基线比较就是对这段时间的复核（§7.2-5 e2e 已钉住） |
| `--resume` 的复核 → 链接 → 提交    | 没有测试缝，但真实的 Ctrl+Z/休眠同样会造成暂停，已由上面两个点覆盖                                 |

**残留**：检查与紧随其后的不可逆动作之间仍有毫秒级窗口。暂停恰好落在这里无法根除（任何「先检查后动作」都如此），只能把窗口缩到这个量级。链接与提交本身各自另有 EEXIST / CAS 守卫。

测试：

- 单测（`convert-state.test.ts`「V7 review M2 …」，7 例）：纯函数边界（两个时钟、回拨、缺证据）；不暂停时基线比较恰好 1 次且无提示；过期但未改动 ⇒ 第 13、14 步前各复核一次，然后成功；第 13 / 14 步前备份被改 ⇒ 74 回滚、不出现「完成：」、写入保留在恢复后的源目录；`--resume` 第 13 / 14 步前被改 ⇒ 76 不提交、状态为 synced / linked，之后 `--abort` 恢复。
- e2e（真 SIGSTOP + 等待 5.6 s）：
  - 「M2: paused at 12:after >5 s, backup changed」⇒ 74，输出含「第 13 步之前重新复核备份」，不出现「完成：」，源目录含那次写入、其余与对照一致，没有登记，旧会话不变。
  - 「M2: paused at 13:after (link built) >5 s, backup changed」⇒ 74，输出含「第 14 步之前重新复核备份」，链接已删、源目录恢复。
  - 「M2: paused at 12:after >5 s with NO change」⇒ 0，复核后成功，备份与对照一致。

### m1 watcher 等锁期间不查父进程 → 等待阶段也每 50 ms 查活

`tests/secure/gocryptfs-test-lock.ts:36–55 / 72`：等锁改为每 50 ms 一次非阻塞 `flock -n -x 3`，每一轮都检查测试进程与其父进程（任一死亡 ⇒ 退出码 2），轮数上限 = 超时 ÷ 50 ms。唯一会接触 fd 3 的子进程是这个非阻塞 `flock -n`，毫秒级就返回，不可能有阻塞中的 flock 子进程比 watcher 活得更久。`sleep` 一律在关闭 fd 3 后运行。

新测试：「WAITING for the lock: vitest's MAIN process SIGKILLed while its worker lives on ⇒ the waiting watcher exits at once (review m1)」。本进程先占住锁；P → W 结构里 W 去等锁；找到 W 下面的等待 watcher 后 SIGKILL P。断言：watcher 在 500 ms 内消失，没有遗留子进程；W 仍然活着；锁文件只剩本进程的持有者；W 始终没有拿到锁。
