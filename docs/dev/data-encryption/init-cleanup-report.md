# init 失败清理报告（用户裁定 2026-10-24）

> 范围：`pi-secure init` 口令出错后的清理。
> 纪律：零 git 写操作、未提交；真实 gocryptfs 只在 token 标记的 mktemp HOME 中用假口令运行（自门控）；没碰真实 `~/secure`、`~/.pi`（用户的私有库 acme）；没碰 `src/schedule/**`、`src/web-hub/**`、`src/index.ts`、`src/stack.ts`。

## 1. 行为

| 场景                                                                                     | 以前                                                        | 现在                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① `gocryptfs -init` 失败（两次新口令不一致等）                                           | 只打印手工清理提示（`initCleanupHint`），骨架、登记全部留下 | **自动清理**：撤销登记，删除本次创建且身份已记录的全部对象，逐条报告；能证明的部分清理完，证明不了的保留并报告（附原手工提示）。退出 1                                                                                                                                                                                                                              |
| ② 首次挂载口令连错 3 次（77），普通库 `unlockVault` 与私有库 `runPrivate setup` 两条路径 | 库已建好、已登记，只留提示                                  | stdin 是 TTY 时询问「是否删除刚创建的空保险库 <名>？删除后刚才打印的 master key 作废，需要重新 pi-secure init <名>。[y/N]」：<br>· `y`/`yes`（不区分大小写）⇒ 同 ① 的清理；<br>· 其他输入、EOF、stdin 非 TTY ⇒ 保留，提示「用正确的口令执行 pi-secure init <名> --fix-settings 补齐目录与 sessionDir」（私有库文案注明「登记为 --private」）。<br>两种结果都退出 77 |
| 认领失败（同名并发 convert/import/init）                                                 | 骨架整体改名搁置为 `.init-failed-*`                         | **不变**（仍只改名，不删除）                                                                                                                                                                                                                                                                                                                                        |

## 2. 实现（`src/secure/bin/helper.mjs`，r1 后的行号）

| 位置                                                                                                                | 内容                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:1765–1853` `createLayout(v, {others, home, hold})`                                                                | 在持有的父目录 fd 内创建每个对象并立即 fstat。`hold`（只有 init 传）时 fd 一直持有到清理结束；不 hold（convert）时只返回身份。详见 §3                                                               |
| `:1229–1350` `INIT_CIPHER_NAMES`/`INIT_CIPHER_MAX_BYTES`、`closeInitHolds`、`prepareInitCipher`、`recordInitCipher` | 持有证据的关闭；`-init` 前确认 cipher 为空、`-init` 后做来源证明（§3）                                                                                                                              |
| `:1354–1398` `initWrittenEntry`、`unclaimInitEntryUnlocked`、`unclaimInitEntry`、`main` 的 `__vault-unclaim`        | settings 锁内的 CAS：条目必须规范化后等于本次写入的内容，然后删除（返回 `deleted`）或恢复认领前的条目（返回 `restored`）；否则 `mismatch`，不写任何东西                                             |
| `:1403–1505` `holdInitVaultLocks`                                                                                   | 依次持有 mount.lease 与 mount.lock，并证明锁住的是本次创建的 inode（§3）                                                                                                                            |
| `:1514–1570` `removeOwnObject`、`:1572` `fileShapeProblem`                                                          | 删除原语与「哨兵形状」检查（§3）                                                                                                                                                                    |
| `:1596–1740` `removeInitVault`                                                                                      | 持锁 → 锁内预检 → CAS 撤销登记 → 自底向上删除；从不抛异常，最后关闭持有的 fd                                                                                                                        |
| `:1742–1763` `formatInitCleanup`                                                                                    | 按实际结果逐条输出（§8 m1）                                                                                                                                                                         |
| `:3146–3233` `cmdInit`                                                                                              | `createLayout(…, {hold:true})`；认领失败先 `closeInitHolds` 再改名搁置；`-init` 前后调用 `prepareInitCipher`/`recordInitCipher`；① 自动清理；② 通过 `offerRemoval` 询问；成功或 `N` 时关闭持有的 fd |

**关于 work/state 哨兵（需求第 1 条的二选一）**：选择「**创建时机不变，清理时同样按身份处理**」，没有把哨兵挪到 `-init` 之后。理由：

1. `createLayout` 是 convert 的端口（V4/V7 已审），convert 第 2 步依赖它一次建好完整的未挂载布局（`checkLayout(unmounted)` 要求有哨兵）。挪动会改变 convert 的布局时序，扩大改动面。
2. 哨兵在 `O_EXCL` 创建的那一刻就从 fd 记录身份并改为持有，清理时还要过「哨兵形状」检查（size=0、权限、nlink），走同一个墓碑原语。两种做法的安全性等价，而这种做法不改变 convert 的时序。
3. 失败路径 ② 本来就会存在哨兵（挂载失败时它们仍在底层），按身份处理无论如何都需要。

## 3. 删除原语的安全论证（安全评审 r1 修订后）

**威胁模型的口径（r1 订正）**：只排除**同 uid 的定向恶意进程**。良性并发与误操作都必须满足 I1（「只删本次创建的对象」）：正常的删除后重建、误放进来的文件、并发的挂载或解锁、写进哨兵的明文。r0 报告把其中一部分归入「同 uid、威胁模型外」，这是错的，已在 r1 中逐条修复（§8）。

**身份证据一直持有**：

- `createLayout(v, {hold:true})` 先打开父目录 fd（`O_DIRECTORY|O_NOFOLLOW`）。在父目录 fd 内完成 mkdir 或 O_EXCL 创建（经 `/proc/self/fd/<pfd>/<name>`，等效于 mkdirat/openat），随即打开并 fstat。
- 目录还须是新建的：属本 uid、为空、ctime 不早于本次开始。文件改为持有 O_PATH fd，并与 O_EXCL fd 的身份比对。
- 这些 fd 一直开着，直到 `removeInitVault` 结束。**被持有的 inode 不可能被回收再分配**，所以后续核对不会把「删除后重建」的对象误认成本次的。
- 不带 hold 时（convert 的端口）只返回身份、立即关闭 fd，convert 的占用检查不受影响。

**cipher 来源证明**：

- `-init` 之前，`prepareInitCipher` 经持有的 fd 确认 cipher 目录为空，且 `v.cipher` 路径仍指向这个目录，并记下开始时刻。
- `-init` 之后，`recordInitCipher` 只接受名字为 `gocryptfs.conf`/`gocryptfs.diriv` 的条目，且须同时满足：普通文件、属本 uid、nlink=1、大小 ≤64 KiB、ctime 与 mtime 都不早于开始时刻（含 100 ms 内核粗时钟余量）。满足的条目改为持有 O_PATH fd。
- 任何一条不满足 ⇒ 整个 `<dir>` 不清理，只报告。

**全程持锁**：

- `holdInitVaultLocks` 按 `releaseRecord` 的顺序取锁：先 mount.lease（外层），再 mount.lock（内层），即 `flock -w … lease flock -w … lock sh -c 'echo locked $$; exec cat'`。
- 最内层进程继承两把锁的 fd，直到我们关闭它的 stdin 或本进程退出。取到锁后，经该进程的 `/proc/<pid>/fd` 证明锁住的正是本次创建的那两个 inode。
- 挂载状态、实例记录（`private.json` 会表现为计划之外的条目）以及全部预检**都在锁内**执行。拿不到锁或证明失败 ⇒ 什么都不删。
- 普通解锁（`doMount`）与私有实例（claim/release）都要取 mount.lock 或租约，所以清理期间不可能有新挂载进入。

**预检（无副作用，在锁内执行）**：每个对象都须满足——

- 持有的 fd 和持有的父目录 fd 都在；
- 父目录**路径**仍指向持有的父目录；
- `<父fd>/<名字>` 的身份等于持有 fd 的身份；
- 目录里除计划内的子项外没有别的条目；
- 我们建的文件仍是「哨兵形状」：size=0、权限与创建时一致（哨兵 0400、锁 0600）、nlink=1、属本 uid。

任何一项不过 ⇒ 不撤销登记、不删除，逐条报告。

**删除原语 `removeOwnObject`**：

1. 调用 tree.mjs 已审的 `renameNoReplace`，把对象改名为同目录唯一墓碑名（父目录身份钉住、源身份钉住、不覆盖、以移动后的身份判定）。若返回非 ok（包括 `unknown`），经持有的父目录 fd **同时探测墓碑名与原名**：墓碑名上是本次对象 ⇒ 按「已移动」继续；原名上是 ⇒ 原样保留；两边都不是 ⇒ 报告「结局不明」，不删除。
2. 墓碑经 `/proc/self/fd/<持有的父fd>/<墓碑>` 以 O_PATH|O_NOFOLLOW 打开并 fstat，必须等于持有对象 fd 的身份（被持有的 inode 不会被回收复用）。
3. 文件用 `unlink`，目录用 `rmdir`（非空即失败，绝不递归），都经持有的父目录 fd 路径执行。证明不了 ⇒ 按当前身份改回原名，或留在墓碑名并报告实际位置。
4. 整个原语不抛异常：任何异常都就地收口为「保留 + 报告条目」，后续对象照常处理、照常报告。

**残留窗口（只针对同 uid 定向恶意进程，即威胁模型排除的那一类）**：墓碑 fstat 与 unlink 之间，在本次自建的 0700 目录里把墓碑名替换掉。良性进程不会去碰随机生成的墓碑名；正常的重建、误放、并发挂载都由上面的持有、持锁和预检排除。

## 4. 对 V6 第二轮裁定「init 不删任何东西」的变更

- **原裁定**（V6 r2）：认领失败时骨架只改名搁置；init 不做任何 unlink/rmdir。
- **新裁定**（用户 2026-10-24）：对于 ① 和 ②，init 删除**本次创建且身份已记录**的对象；删除只能经 §3 的可证明原语，证明不了即保留并报告。
- **未变部分**：认领失败路径仍只改名（`setAsideInitSkeleton`），因为那时同名库可能正被另一个事务发布，删除会与对方竞争；init 主体仍然不直接删除。
- **源码钉住测试**：`tests/secure/launcher-v6-wiring.test.ts` 中「init deletes only through removeInitVault's tombstone primitive; the claim-loss path still only renames」取代了原来的「init itself never deletes」。
- **待安全评审**：本改动推翻了一条安全裁定，需要按需求再过一次安全评审（§3 是给评审的论证）。

## 5. 冻结面

- `tests/fixtures/secure-launcher-off-golden.json` **未改动、未重生成**。其中 `fake/init-tty-init-fails` 一例的输出按裁定 ① **必然**变化（原输出是手工清理提示），这与「golden 只允许 USAGE 变化」的约束冲突。处理方式：在 `tests/secure/launcher-off-golden.test.ts` 中加入显式的 `RULING_OVERRIDES`，同时钉住两样东西——fixture 里仍是旧字节（`was`），以及实际输出必须等于新字节（`now`）。只覆盖这一例，其余 54 例照旧逐字节比对。**这一点请主会话确认。**
- `secure-contract-parity.json`、`secure-off-golden.json`：未改动。
- USAGE：未改动。

## 6. 测试

| 文件                                                                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/secure/init-cleanup.test.ts`（新，11 例，无 FUSE）                                 | ① `createLayout` 记录全部对象，`recordInitCipher` 只收两个名字；② 正路径：撤销登记、删除 9 项，不留墓碑，父目录和兄弟目录不动，报告格式；③ re-init：原条目被**恢复**而非删除；④ cipher 多出 `extra` ⇒ 整体不清理；⑤ `mount.lock` 被换（原 inode 保留存活）⇒ 不删，冒充者存活；⑥ 挂载点父目录换成符号链接 ⇒ 不删，外部数据与真实挂载点都不动；⑦ 挂载点里有 `stray` ⇒ 不删；⑧ 仍挂载或租约忙 ⇒ 不删；⑨ settings 条目被并发改 ⇒ CAS `mismatch`，不删；⑩ **预检之后、墓碑处被换**（通过包装 `renameNoReplace` 注入）⇒ 冒充者被改回原名而**不是被删除**，`<dir>` 因非空改回原名，另一半（mnt）照常清理，不留墓碑；⑪ `unclaimInitEntryUnlocked` 的 missing、精确匹配、mismatch |
| `tests/secure/init-cleanup-real.test.ts`（新，4 例，真 gocryptfs + 真启动器 PTY，自门控） | ① 两次新口令不一致 ⇒ 退出 1，无残留（dir、mnt、登记都不在）；② 挂载口令连错 3 次 + `y` ⇒ 77，提示文案含「master key 作废」，无残留、未挂载；③ `n` ⇒ 保留且已登记，`init --fix-settings` 用正确口令补齐（挂载、`work/.pi/settings.json`），之后 `lock` 和 `status` 为 `layout ok`；④ `--private`：`y` ⇒ 无残留；`n` ⇒ 保留（`private:true`），`--fix-settings` 在私有命名空间内补齐、结束后未挂载                                                                                                                                                                                                                                                                         |
| `tests/secure/launcher-cli.test.ts`                                                       | 「review #4」一例改为新行为：`-init` 失败后两个位置和登记都不存在、报告点名两个位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests/secure/launcher-off-golden.test.ts`                                                | §5 的裁定覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/secure/launcher-v6-wiring.test.ts`                                                 | 源码钉住测试（§4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/secure/private-real-harness.ts`                                                    | `tty()` 只追加可选参数 `passwords`（按提示顺序给出各次口令），默认行为逐字节不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**变异核验**：

- 删掉 `removeOwnObject` 里的墓碑身份核对时，⑩ 中冒充者会被删除——该用例正是用来抓这种回归的。
- 删掉预检时，④–⑨ 都会删除东西。

## 7. 残留

1. **②「非交互 ⇒ N」实际上碰不到**：init 在建任何东西之前就要求 stdin/stdout 都是 TTY（`requireTty` + stdout 检查），所以非 TTY 时根本到不了 ②。代码里仍按要求实现了「stdin 非 TTY ⇒ 不问、保留」和「EOF ⇒ N」（`promptLine` 关闭时返回 `""`），但没有端到端用例覆盖这条分支。
2. `~/secure` 由 init 自动创建时不会被清理：它是公共父目录，不属于「本次创建的保险库对象」；空目录无害。
3. §3 末尾的残留窗口：只对同 uid 定向恶意进程存在（威胁模型排除的那一类）。
4. `npm run typecheck` 只因其他会话在途的 `src/web-hub/hub/schedule/{hub-state,scan}.ts` 报错（见交付消息），与本改动无关。

## 8. 安全评审 r1 处置（`/tmp/init-cleanup-sec-r1.json`：3 blocker / 2 major / 1 minor）

| #   | 问题                                  | 修复（`helper.mjs` 行号）                                                                                                                                                                                                                    | 回归测试（`tests/secure/init-cleanup.test.ts`）                                                                                                                                                          | 变异核验（去掉修复 ⇒ 变红）                                         |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| B1  | 只做快照读，没有持有 mount.lock/lease | `holdInitVaultLocks` `:1403`：lease→lock 两把锁，经 /proc fd 证明锁住的是本次的 inode；`removeInitVault` `:1596` 把预检与删除全部放在锁内                                                                                                    | 「r1 #1: another holder of mount.lock (or mount.lease)」（两把锁各测一次）、「r1 #1: … a swapped mount.lock ⇒ refused」、「still mounted (checked INSIDE the locks)」（断言 probe 执行时两把锁都被持有） | 把取锁换成空实现 ⇒ 3 例红                                           |
| B2  | cipher 文件没有来源证明               | `prepareInitCipher` `:1288`（-init 前为空、路径仍绑定、记开始时刻）；`recordInitCipher` `:1309`（白名单 + 普通文件 + 本 uid + nlink=1 + ≤64 KiB + ctime/mtime ≥ 开始时刻，并持有 fd）                                                        | 「r1 #2: a file already in cipher BEFORE -init」；「gocryptfs.conf with an old mtime / a second hard link / an oversized file」                                                                          | 去掉 nlink/size/时刻检查 ⇒ 3 例红；去掉 -init 前为空的检查 ⇒ 1 例红 |
| B3  | 目录身份按路径重取，fd 随即关闭       | `createLayout` `:1765–1853`：在持有的父目录 fd 内创建、新建目录检查、持有全部 fd；预检与删除以持有的 fd 为准；另加父目录路径绑定检查                                                                                                         | 「r1 #3: … removed and re-created at the same path never matches」、「r1 #3: without the held evidence nothing is deleted」、「createLayout records … (the evidence is HELD)」                           | createLayout 不持有 fd ⇒ 正路径等 8 例红（证据确实承重）            |
| M1  | 哨兵只核 dev/ino                      | `fileShapeProblem` `:1572`：size=0、权限与创建时一致、nlink=1、属本 uid                                                                                                                                                                      | 「r1 #4: a sentinel that is non-empty / mode changed / hard-linked elsewhere」                                                                                                                           | 去掉 size 检查 ⇒ 非空一例红                                         |
| M2  | `unknown` 时丢失墓碑位置；异常未收口  | `removeOwnObject` `:1514`：两处探测、按身份判定；整个原语 try/catch 收口；`putBack` 的异常也收口                                                                                                                                             | 「r1 #5: renameNoReplace says 'unknown' although it DID move」、「r1 #5: a primitive that throws is contained」（登记已撤销、部分残留时报告列全并给出手工处理提示）                                      | 去掉两处探测 ⇒ 1 例红                                               |
| m1  | 输出与实际不符                        | `formatInitCleanup` `:1742`：登记状态分已撤销/已恢复原条目/已不存在/未动；逐条「已删除：<路径>」「保留未动：<路径>（原因）」；登记已处理但有残留时给出手工删除提示，否则附 `initCleanupHint`；cmdInit 标题改为中性的「清理本次创建的内容：」 | 「r1 minor: the report reflects a skipped cleanup」、正路径逐条比对、re-init「已把 … 恢复为本次 init 之前的登记」                                                                                        | —                                                                   |

- **其他调整**：`cmdInit` 在成功、`N` 和认领失败三条路径上都调用 `closeInitHolds`（成功路径在 finalize 之前关闭，避免占用扫描看到本进程）。N0 golden 的显式覆盖 `now` 同步为逐条输出（fixture 仍未改动）。`launcher-cli` 与 `launcher-v6-wiring` 的断言随之更新——源码钉住测试仍然钉住：删除只有 `rmdirSync(fdp(pfd, tomb))` 与 `unlinkSync(fdp(pfd, tomb))` 两处，`fdp` 的定义是 `/proc/self/fd/<fd>/<name>`。
- **测试数**：`init-cleanup.test.ts` 25 例（r0 11 例 + r1 14 例）；`init-cleanup-real.test.ts` 4 例不变（文案断言同步）。

## 9. 评审第 2 轮处置（`/tmp/init-cleanup-sec-r2.json`：上轮 6 项 2 closed / 4 not-closed；主会话裁定：不再开第三轮，修完由主会话核对）

| 上轮项                                              | r2 结论    | 处置                                                                                                                                                                                                                                                                                                                                                                    | 回归测试（`init-cleanup.test.ts`）                                                                                                                                                             | 变异核验（去掉修复 ⇒ 变红）                      |
| --------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| #3 createIn 关闭 O_EXCL fd 后按名字重开 O_PATH      | not-closed | **已修**：`createLayout` 的 `createIn` 直接持有 O_EXCL 创建得到的 fd，并以它的 fstat 作为身份（fchmod 也作用在这个 fd 上），不再按名字重开                                                                                                                                                                                                                              | 「r2 #3: the held evidence for every created file IS its O_EXCL creating fd」（读 `/proc/self/fdinfo`：持有的是 O_WRONLY 创建 fd，不是 O_PATH 重开）                                           | 恢复成「关闭后按名字重开 O_PATH」⇒ 1 例红        |
| #4 哨兵形状只在预检检查                             | not-closed | **已修**：`removeOwnObject` 在改成墓碑名、核对身份之后，对墓碑的 fstat 结果再检查一次 `fileShapeProblem`（size=0、nlink=1、类型、权限与创建时一致、属主；cipher 文件检查大小上限），不符 ⇒ 改回原名或保留并报告                                                                                                                                                         | 「r2 #4: data written into a sentinel AFTER the preflight (same inode) is caught at the tombstone, never unlinked」（预检之后经路径向同一 inode 写入数据 ⇒ 数据保留在原名下）                  | 去掉墓碑处的复核 ⇒ 3 例红                        |
| #5 回退 rename unknown 未重探测；坐标用旧父路径拼接 | not-closed | **已修**：`putBack` 不再相信回退 rename 的返回值（ok / unchanged / unknown / 抛异常都一样），一律经持有的父目录 fd 重新探测原名与墓碑名，按身份如实报告「已改回原名 / 留在墓碑名 / 原名上现有一个对象 / 位置不明」。报告中的坐标改为持有的父目录 fd 当前的路径（`readlink /proc/self/fd/<fd>`，并核对该路径仍指向这个目录）；取不到时写「（父目录已移动，原位置未知）」 | 「r2 #5: a rename back that reports 'unknown' but DID happen is reported where it actually is」；「r2 #5: coordinates come from the held parent fd's CURRENT path (parent renamed meanwhile)」 | 去掉重新探测 ⇒ 3 例红；改回旧父路径拼接 ⇒ 1 例红 |
| #2 cipher 文件的创建者证明                          | not-closed | **接受为残差**（主会话裁定），理由见下                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                              | —                                                |
| #3 中「mkdir 与随后 open 分离」窗口                 | not-closed | **接受为残差**（主会话裁定），理由见下                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                              | —                                                |
| #1、#6                                              | closed     | —                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                              | —                                                |

### 接受的残差（主会话裁定）

| 残差                               | 现状                                                                                                                  | 理由                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-a：cipher 文件的创建者无法被证明 | 只能用属性筛选：同名白名单、-init 前目录已证空、普通文件、本 uid、nlink=1、≤64 KiB、ctime/mtime 不早于 -init 开始时刻 | cipher 目录是本次新建的、0700、fd 一直持有，-init 之前已证明为空。在 init 进行的几秒里，有正常程序恰好往这个新的私有目录复制同名的 `gocryptfs.conf`/`gocryptfs.diriv`，不属于现实中的良性并发；属性筛选是合理的尽力而为。若真有这类文件，删掉的也只是一份与本次 -init 同名、同时间窗的密文元数据，不会是用户数据目录 |
| R-b：mkdir 与随后 open 之间的窗口  | 在持有的父目录 fd 内 mkdir，随后经同一父目录 fd 打开并 fstat，并检查为空、属本 uid、ctime 不早于本次开始              | 父目录是持有的；要在这个窗口里把刚建的私有目录换掉，需要定向行为（威胁模型排除的同 uid 定向恶意进程）。即便发生，open 之后的检查（空目录、属主、时间）也保证被持有、之后被使用和清理的就是一个本次时间窗内新建的空目录；init 的子项都建在被持有的这个目录里，清理也只删它                                            |

**剩余的极小窗口**：墓碑处的形状复核与 unlink 之间，若有进程经**早已打开的 fd** 向同一 inode 写入，这部分数据会随 unlink 一起消失。经路径的写入在改成墓碑名后已找不到原名，因此只有「在预检之前就已打开该哨兵并持续写入」的进程能做到——这是对一个 0400、空的哨兵文件的异常行为。
