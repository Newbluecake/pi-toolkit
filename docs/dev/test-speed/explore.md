# 全量测试耗时调研（explore）

> 任务：搞清「全量 `npm test` 太慢」的结构，为后续方案提供事实基础。**本文只陈述事实与数量级，不给方案。**
> 标注：**[F]** = 读代码/日志/实测确认；**[I]** = 推断（给出推断依据）。
> 代码基线 `d05552ac`（被测运行在 `bfa16784`）；实测数据来自 `/tmp/batch-test.log`（读于 13:58，全文 9129 行）与 `/tmp/rerun-secure.log`（读于 14:05，**当时仍在写**：已写完 6 个文件，`launcher-convert` 未见完成）。
> 本次未运行 `npm test`、未运行任何 `tests/secure/**`（另一轮 secure 复跑在 `/tmp/v-batch` 占用 gocryptfs 锁）。只跑了 4 次单个/两个非 secure 小测试文件取证（见附录 A）。

---

## 0. 结论速览

1. **慢的根源不是"文件多"，是极少数文件**：解析到 1755 个文件、worker-time 合计 **8609 s**，其中 **Top 9 个文件占 55%**，Top 29 占 80%。 [F]
2. **`tests/secure` + `tests/conformance/secure-*` 两个目录吃掉 68%**：`tests/secure` 36 文件 / 4352 s；`tests/conformance` 38 文件 / 1613 s，而其中 **5 个 `secure-*` 文件就占 1471 s**（其余 33 个 conformance 文件合计 142 s）。 [F]
3. **Tier 1（AGENTS.md 定义的高频硬门禁）其实很便宜**：1524 文件 / 1057 s = 12%；按 4 worker 折算 ≈ 5–7 min（含 collect/prepare）。慢的全部落在 Tier 2。 [F]/[I]
4. **这次 39 分钟的测量被两个并发 vitest 进程污染**，且污染方式不是"抢 CPU"，而是**抢同机 gocryptfs 锁 + 共享挂载/同名路径**：5 个 secure 套件在 `beforeAll` 里把锁预算跑满（240 s / 560 s）后失败；`launcher-convert` 31 个用例逐个烧 90 s 轮询。 [F]
5. **`launcher-convert` 的 2175 s 有独立于并发的第二个根因**：它的 scratch 根在 `<repo>/node_modules/.cache/v7`，而本轮 `/tmp/v-batch` 的 `node_modules` 是**符号链接**到主仓；`pi-secure` 用**原样路径**挂载、用 **realpath** 校验 ⇒ 每次挂载都被判 `foreign` ⇒ 每例回滚失败（74）+ 空等 90 s 的 seam 轮询。 [F]（现场 mountinfo 证据见 §2.3）
6. 这台机器上**常驻 4 个同 uid 但不可检查的进程**（`(sd-pam)`、两个 `sshd`、`logger`），会让 2026-10-24 新增的 `confirmUnreadable` 确认门**每次都触发**，额外插入一次交互提示，足以打乱脚本化 stdin 的用例。 [F]
7. `collect 396.9 s` / `prepare 95.2 s` 合计只占 worker-time 的 **4.6% / 1.1%**，**不是瓶颈**；`prepare ≈ 54 ms/文件 × 1755`（setupFiles 固定成本），`collect` 主要来自 48 个 `import src/index.js` 的重型模块图（实测冷启 6.5–6.8 s/文件，同 worker 复用后约 1.6 s）。 [F]
8. **worker 数已接近最优**：4 worker 的理想下限 2152 s vs 实测 2347 s，只有 ~8% 可回收；瓶颈是"单个文件 2175 s"这种串行长尾，不是并行度。 [F]
9. **CI 根本不会跑这些慢套件**：GitHub runner 上没有 gocryptfs/fusermount3 ⇒ 所有 real-mount 套件被 `realSkipReason()` / `HAVE_FUSE_STACK` 自门控 skip（纯逻辑的 secure 用例照跑，如 `gocryptfs-test-lock.test.ts`、`convert-preflight.test.ts`）；也就是说 68% 的耗时**只在本地（发版前的 `npm test`）**发生。 [I]（依据：自门控代码只探测二进制与 `/dev/fuse`，见 §2.4）
10. 与 2026-10 的「~210 s」对照：`vitest.config.ts:31-36` 的注释是 2026-10-15 写下的，而 `tests/secure/launcher-convert.test.ts`、`convert-state.test.ts`、`conformance/secure-convert*.test.ts` 都是在 **2026-10-24/25/26** 才落地（`git log --diff-filter=A`），另有 `tests/governance/bundle-parity.test.ts` 在 **2026-11-03**。**10× 回归的时间窗与这批 real-mount e2e 重合**。 [F]

---

## 1. 数据与口径

| 项                                    | 值                                                                                                                                                               | 来源                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 运行 A（39 分钟那次，Start 13:08:15） | `Duration 2346.78s`，`Test Files 8 failed \| 1746 passed \| 1 skipped (1755)`，`Tests 33 failed \| 33436 passed \| 71 skipped \| 1 todo (33541)`                 | `/tmp/batch-test.log:8136-8139` [F] |
| 运行 A 明细                           | `transform 36.39s, setup 22.89s, collect 396.90s, tests 8608.61s, environment 38.26s, prepare 95.24s`                                                            | 同上 [F]                            |
| 运行 B（残留进程，Start 12:58:02）    | `Duration 2901.46s`，`Test Files 18 failed \| 1736 passed`，`Tests 56 failed`                                                                                    | `/tmp/batch-test.log:9125-9128` [F] |
| 两轮重叠                              | 12:58 → 13:46（≈48 min 的运行覆盖了 13:08 那轮的前 38 min）；日志里因此有两段汇总                                                                                | [F]                                 |
| 单文件耗时解析                        | 1755 条文件记录，逐文件耗时合计 **8608.9 s**，与运行 A 的 `tests 8608.61s` 吻合 ⇒ **逐文件明细属于运行 A**                                                       | 本文 `/tmp/parse-vitest.mjs` [F]    |
| 并发造成的失真                        | 逐文件记录几乎只出现一次（仅 1 个文件重复），说明日志里没有两套完整明细；但**运行 A 的耗时本身含并发争用**（尤其锁等待），故 8609 s 只能当"观测值"，不是"干净值" | [F]/[I]                             |

> 口径提醒：`PI_TOOLKIT_TEST_WORKERS=4`、`maxWorkers: 4`，墙钟 2347 s ⇒ 理论并行下限 `8609/4 = 2152 s`，即 **只有 8% 的墙钟是"并行度不足/长尾空转"**，其余全是真实的串行工作量。 [F]

---

## 2. Q1 — secure 套件为什么失败，为什么每例都等到超时

### 2.1 环境前置条件探测（只读命令，14:00 实测）

| 检查                                                         | 结果                                                                                                                                         | 结论                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `which gocryptfs fusermount fusermount3 setpriv unshare tar` | 全部存在：`/usr/bin/{gocryptfs,fusermount,fusermount3,setpriv,unshare,tar}`                                                                  | 不缺二进制 [F]                               |
| `gocryptfs -version`                                         | `gocryptfs 1.8.0; go-fuse 2.0.3; 2024-11-18 go1.18.1 linux/amd64`                                                                            | [F]                                          |
| `fusermount3 --version`                                      | `3.10.5`                                                                                                                                     | [F]                                          |
| `/dev/fuse` 权限                                             | `crw-rw-rw- 1 root root 10, 229`                                                                                                             | 可读写 [F]                                   |
| `id`                                                         | `uid=1001(bluecake) gid=1001(bluecake) groups=1001(sudo),121(docker)`                                                                        | [F]                                          |
| `mount \| grep -i gocryptfs`                                 | **1 个残留挂载**：`/home/bluecake/ai/pi-toolkit/node_modules/.cache/v7/v7lD1qdy/.../cipher on /tmp/ps-v7mnt-8L2M3o/proj type fuse.gocryptfs` | 失败运行留下的全局挂载，**会毒化下一轮** [F] |
| `/tmp/pi-secure-gocryptfs-tests-1001.lock`                   | 存在（0 字节，11-04 19:19），inode `2049:24384`；`/proc/locks` 未显示该 inode 被持有                                                         | 锁文件本身合法，flock 由 holder 进程持有 [F] |
| 同 uid 但 `/proc/<pid>/{cwd,fd,maps}` 不可读的进程           | **4 个**：`1276 (sd-pam)`、`15348 sshd`、`1575355 sshd`、`379749 logger`                                                                     | 见 §2.3(c) [F]                               |

**结论**：这台机器上前置条件**齐全**，secure 不是"缺依赖才失败"。失败是**行为级失败**（锁 / 路径 / 挂载状态判定）。 [F]

### 2.2 日志里能看到的两类失败

**(a) 五个套件在 `beforeAll` 把锁预算跑满后失败** — `/tmp/batch-test.log:6787-6800`：

```
FAIL tests/conformance/secure-convert.test.ts > XC4 / XC5 — export against real gocryptfs + GNU tar
FAIL tests/secure/helper-v0-api.test.ts       > V0 unlockVault({postMount:false}) against real gocryptfs
FAIL tests/secure/launcher-fuse.test.ts       > pi-secure against real gocryptfs
FAIL tests/secure/launcher-off-golden.test.ts  > N0 golden — real gocryptfs (test-side mounts, fake passfile)
FAIL tests/secure/launcher-private.test.ts     > N4 e2e: run --private on real gocryptfs + unshare
Error: gocryptfs test lock not acquired (holder exit 1)
 ❯ ChildProcess.<anonymous> tests/secure/gocryptfs-test-lock.ts:106:16
```

`holder exit 1` 的语义是**轮询次数耗尽**（`tests/secure/gocryptfs-test-lock.ts:63` 的 `timeoutMs = 240_000`，`HOLDER_SH` 里 `n >= polls ⇒ exit 1`），即**不是**"有人抢锁导致立刻失败"，而是**静默等满预算再失败**。各套件的预算与实测耗时：

| 文件                                           | 锁预算                                 | 实测耗时                                      | 打印出来的用例耗时 |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------- | ------------------ |
| `tests/secure/launcher-private.test.ts`        | 240 s（默认） `:63`                    | 249.4 s（21 例全 skip）                       | 0 s                |
| `tests/secure/launcher-fuse.test.ts`           | 240 s（默认） `:54`                    | 249.0 s（18 例全 skip）                       | 0 s                |
| `tests/secure/helper-v0-api.test.ts`           | 240 s（默认） `:548`                   | 252.2 s（31 例，3 skip）                      | 1.1 s              |
| `tests/secure/launcher-off-golden.test.ts`     | 240 s（默认） `:605`                   | 277.6 s                                       | 26.0 s             |
| `tests/conformance/secure-convert.test.ts`     | 560 s `:110`                           | 582.4 s                                       | 0 s                |
| `tests/conformance/secure-convert-xc2.test.ts` | 400 s `:222`                           | 178.3 s（唯一打印用例 721 ms ⇒ 其余全是等待） | 0.7 s              |
| `tests/conformance/secure-gocryptfs.test.ts`   | 240 s + `secure-probe.sh` 170 s `:103` | 178.5 s                                       | 2.3 s              |

⇒ 光这 7 个文件里"锁等待 + 空转"就约 **1600 s**，全部发生在并发运行期间。 [F]（逐文件明细见附录 B 的解析结果）

同一现象在**隔离复跑**里也能看到（`/tmp/rerun-secure.log`，2 worker）：`tests/secure/launcher-private-cmd.test.ts`（42 例，取锁预算 590 s，`tests/secure/launcher-private-cmd.test.ts:771`）耗时 **610.7 s**，但它打印出来的用例只有 3.4 s / 3.3 s / 0.4 s / … 量级 ⇒ **~590 s 全是等锁**。该轮在 13:33–13:47 之间与全量两轮重叠，锁被对方持有 ⇒ 说明"等锁"成本不需要第二个 vitest 进程**长期**存在，只要两轮有交集，等待者就会把 590 s 预算烧满。 [F]

**(b) `launcher-convert` 31 个用例逐个超时** — `/tmp/batch-test.log:6540-6541` 起，两类报错：

1. `源目录被占用：以下同 uid 进程无法检查（/proc 读不到其 cwd/fd/maps）… 继续？[y/N] y` — 见 §2.3(c)；
2. `pi-secure: gocryptfs 返回成功，但 mountinfo 不符（foreign）… 回滚不完整 … expected 74 to be +0` — 挂载成功却被判定不是"我们的挂载"，随后回滚拒绝卸载；
3. `timed out waiting for: launcher stopped at the seam` — 90.1 s × 8 例、120.7 s × 1、674.2 s × 1。

### 2.3 三个直接原因（可定位到代码）

**(a) 跨进程锁：`gocryptfs-test-lock.ts` 是"每机一把、按块独占"的设计**
`tests/secure/gocryptfs-test-lock.ts:1-30` 的注释写明：vitest 并行 worker 会互相干扰，所以**所有做真实全局挂载的套件用一把 `flock` 串起来**。`launcher-convert` 更进一步是**每个用例**取锁（`:429-437`：`beforeEach` 取锁 590 s 预算、`testTimeout 600 s`）。
⇒ 两个 vitest 进程并发时，两侧共 ~10 个 real-mount 块要串行通过同一把锁；后到者的预算（240–590 s）被先到者吃掉 ⇒ `holder exit 1` / 用例级 590 s 等待。**这是"污染"最贵的一条**。 [F]

**(b) 路径拼写不一致 ⇒ 每次挂载被判 `foreign`（`launcher-convert` 的独立根因）**

三条事实串起来：

1. `launcher-convert` 的 scratch 根固定为 `<REPO>/node_modules/.cache/v7`（`tests/secure/launcher-convert.test.ts:81`），因为"源目录必须在 `$HOME` 下且不能在 `/tmp`"（`:76-80` 注释）。 [F]
2. 本次运行目录 `/tmp/v-batch` 的 `node_modules` 是**符号链接**：`/tmp/v-batch/node_modules -> /home/bluecake/ai/pi-toolkit/node_modules`（`ls -ld` 实测）。于是同一个物理目录有两种拼写：`/tmp/v-batch/node_modules/...` 与 `/home/bluecake/ai/pi-toolkit/node_modules/...`。 [F]
3. 挂载时传给 gocryptfs 的是**原样路径**：`src/secure/bin/helper.mjs:3080` `leaseChainArgs(v.lease, ["gocryptfs","-nonempty","--", v.cipher, v.mnt])`；而校验用的是 **realpath**：`helper.mjs:282-287` `vaultMountState()` 要求 `last.source === realCipher`，`realCipher` 来自 `physicalPaths()`（`helper.mjs:320-350`，`fs.realpathSync`）。 [F]
4. **gocryptfs 1.8.0 不会把 source 规范化**——现场证据（14:03 读的计划 B 进程的挂载）：

```
844 29 0:69 / /tmp/ps-v7mnt-YklWyp/proj rw,nosuid,nodev,relatime shared:55 - fuse.gocryptfs
    /tmp/v-batch/node_modules/.cache/v7/v7Vyhxvm/home/.local/share/pi-toolkit-secure/proj/cipher rw,user_id=1001,...
```

同一进程的 cmdline 也是 `/tmp/v-batch/...`；而 realCipher 会算成 `/home/bluecake/ai/pi-toolkit/node_modules/.cache/v7/...` ⇒ **`source !== realCipher` ⇒ `foreign`**。 [F]（`/proc/<pid>/cmdline` 与 `/proc/self/mountinfo` 对照，只读）

5. 日志里同一进程同时打印两种拼写，佐证了这一点：`源：/home/bluecake/ai/pi-toolkit/node_modules/.cache/v7/v7eCfnYH/home/proj` 但 `保险库：元数据 /tmp/v-batch/node_modules/.cache/v7/v7eCfnYH/...`（`/tmp/batch-test.log:6543-6546`）。 [F]

后果链：`waitMountState(v,"mounted",3_000)` 拿到 `foreign` ⇒ `helper.mjs:3089-3092` 抛 `gocryptfs 返回成功，但 mountinfo 不符（foreign）` ⇒ convert 回滚时 `helper.mjs:2505` `foreign ⇒ 不动它` ⇒ `74 回滚不完整`，并且**留下全局挂载**（下一轮 `run --private` 直接拒绝/跳过）。 [F]

> **为什么不是所有 secure 文件都失败**：`RealHarness.setup()` 默认 `root = tmpdir()`（`tests/secure/private-real-harness.ts:200-205`），`/tmp` 本身不是符号链接 ⇒ 那些套件（`convert-state`、`archive`、`tree`、`launcher-private-unit`）的 realpath 与原样路径一致 ⇒ 挂载判定正常。只有 scratch 根落在 `node_modules/.cache/v7`（符号链接路径）的 `launcher-convert` 全灭。 [F]
> 这条对**任何**"repo 路径含符号链接（含把 node_modules 软链到别处的 worktree/容器挂载）"的运行都成立，是产品侧 `physicalPaths` / 挂载路径拼写不一致，测试无法绕过。 [F]/[I]

**(c) 新增的"不可检查同 uid 进程"确认门在这台机器上恒触发**

`src/secure/bin/convert.mjs:1008-1060` `confirmUnreadable()`（注释标注 _User ruling 2026-10-24 (M8)_）：同 uid 但 `/proc/<pid>/{cwd,fd,maps}` 读不到的进程会被**逐一列出并要求交互确认**（非交互需 `--assume-unreadable-idle`，否则 75）。这台机器常驻 4 个这样的进程（`(sd-pam)`、`sshd`×2、`logger`，§2.1）⇒ 每个 convert 都会先插入一次 `继续？[y/N]`（`:1052`）。日志里就是这段：`/tmp/batch-test.log:6542-6549`。 [F]

对测试的影响：

- 交互式用例（harness 喂 `y`）能过，但**多了一次提示**；
- 用固定 stdin 脚本、按"第 N 个 prompt"对齐的用例会**错位**，跟着报 `测试缝：第 N 步注入失败` / `源目录被占用… to contain '持久化屏障'`（`/tmp/batch-test.log:6891-6892`、`7697-7698`）；
- 这也解释了为什么这些用例**在 CI 上大概率是绿的**：Ubuntu runner 上没有 sshd/sd-pam 这类 non-dumpable 常驻进程。 [I]

**(d) 为什么"每个用例都要等到超时"而不是快速失败**

| 机制                                                     | 位置                                                                                                                                           | 默认/预算                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 跨套件锁：轮询到预算耗尽才 reject                        | `tests/secure/gocryptfs-test-lock.ts:63,106`                                                                                                   | 240 s（个别 400/560/590 s） |
| seam 等待：50 ms 轮询，等不到就烧满                      | `tests/secure/launcher-convert.test.ts:389-392`（`waitStopped(ms = 90_000)`）、`tests/secure/private-real-harness.ts:453-464`（`until`）       | 90 s/例                     |
| 等"外来挂载消失"：50 s 轮询，超时后**直接 `ctx.skip()`** | `tests/secure/private-real-harness.ts:523-536`                                                                                                 | 60 s/例，然后静默 skip      |
| 套件级 `beforeAll` 超时                                  | `launcher-private.test.ts:65-67` `250_000`；`launcher-convert.test.ts:431` `600_000`；`conformance/secure-gocryptfs.test.ts:105-107` `430_000` | —                           |

⇒ 这些是**故意设计成"慢失败"**（等待并发让路 + 有界预算），在没有并发时它们表现为正常耗时；一旦前置条件坏掉，就整体退化为"每例烧满预算"。**没有一个前置探测会在开跑前判定"这一轮注定会全灭"**。 [F]

### 2.4 现有的前置探测 / 自门控

| 机制                                  | 位置                                                                         | 覆盖面                                                                                                                                              | 缺什么                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `realSkipReason()`                    | `tests/secure/private-real-harness.ts:47-58`                                 | linux；`gocryptfs/fusermount3/flock/script/unshare/umount` 存在；`/dev/fuse` 可读写；`unshare --user --map-root-user --mount` 可用 ⇒ 返回 `""` 才跑 | 不看：残留全局挂载、scratch 路径是否有符号链接、不可检查进程、锁是否被别的进程长期持有 [F] |
| `HAVE_FUSE_STACK`                     | `tests/conformance/secure-gocryptfs.test.ts:53-58` + `describe.skipIf` `:81` | 同上（另要求 `timeout`）                                                                                                                            | 同上 [F]                                                                                   |
| `awaitNoForeignGocryptfs()`           | `tests/secure/private-real-harness.ts:523-536`                               | 只在 `launcher-private` / `launcher-v6-wiring` 的每个用例前用：等 60 s 后 **skip 该用例**                                                           | 是"用例级静默 skip"，不是"整体门控"；会把"环境脏"变成"覆盖率静默丢失 + 每例 60 s" [F]      |
| `gocryptfs-test-lock.ts` 的 `alive()` | `:60-64`                                                                     | 保证 holder 随测试进程死亡而释放（ppid/自身 pid 轮询）                                                                                              | 不区分"等锁"与"锁坏了"，一律烧满预算 [F]                                                   |

**结论**：机器层面的缺依赖已经门控住了（CI 上确实会 skip）；**但"环境脏 / 布局坏"这三种情况完全没有门控**。 [F]

### 2.5 能否 fail-fast / skip 而不削弱断言（事实层）

- 现有的 skip 已经是"整块 `describe.skipIf`"（`realSkipReason` / `HAVE_FUSE_STACK`），**断言内容不因 skip 而减弱**，只是不跑；先例充分。 [F]
- 日志里出现的失败**没有一种是"断言变弱就能过"**：要么是环境布局（拼写/残留挂载/常驻进程），要么是真 bug 候选（`stack-teardown-matrix` G10、`launcher-helper` 的 `findPiPackage`）。**用 skip 掩盖它们等于放弃覆盖**。 [F]
- 真正"不削弱断言"的 fail-fast 只能做成**前置条件断言**（例如"scratch 根 realpath == 原样路径"、"`mount | grep gocryptfs` 为空"、"锁文件 inode 未被持有"）——先判、先拒，而不是后来才发现。仓库目前**没有**这样的前置判定。 [F]/[I]
- `launcher-helper.test.ts` 在 `/tmp/v-batch` 里唯一失败的用例是 `findPiPackage walks up from the real pi entry to the package root`（`/tmp/rerun-secure.log:127-128`），期望 `/tmp/v-batch/node_modules/@earendil-w…`、实际 `/home/bluecake/ai/pi-toolkit/node_mod…` —— **同一个符号链接的另一个受害者**（realpath 后拼写不同），**与 secure 锁无关**。 [F]

---

## 3. Q2 — 按目录 / 类型统计

### 3.1 目录级（worker-seconds = 逐文件耗时之和，运行 A）

| 目录                | 文件数      | worker-s   | 占比  | 备注                                                                            |
| ------------------- | ----------- | ---------- | ----- | ------------------------------------------------------------------------------- |
| `tests/secure`      | 36          | **4352.3** | 50.6% | 14 个文件 >20 s，合计 4320 s（即该目录 99% 的耗时集中在这里）                   |
| `tests/conformance` | 38          | **1612.5** | 18.7% | 其中 5 个 `secure-*` 占 1471 s；其余 33 个仅 142 s                              |
| `tests/integration` | 151         | **1586.0** | 18.4% | 31 个文件 >10 s = 1457 s；`fabric-xs*`/`fabric-thread*` 家族 29 文件 739 s      |
| `tests/web-hub`     | 754         | 627.2      | 7.3%  | 平均 0.83 s/文件；最慢 `ui/logic-markdown-perf` 43 s、`hub/feishu/service` 42 s |
| `tests/governance`  | 2           | 147.5      | 1.7%  | `bundle-parity` 147 s（真实 tsx 子进程）                                        |
| `tests/release`     | 5           | 55.6       | 0.6%  | `package-zip` 36 s（真的跑 `scripts/release/package.sh` 打 zip）                |
| `tests/workflow`    | 34          | 54.3       | 0.6%  |                                                                                 |
| `tests/memory`      | 93          | 31.9       | 0.4%  |                                                                                 |
| `tests/traffic`     | 32          | 30.2       | 0.4%  |                                                                                 |
| `tests/service`     | 42          | 24.8       | 0.3%  |                                                                                 |
| 其余 40+ 目录       | 各 <25 文件 | 合计 ≈ 90  | 1%    | `schedule 13.7`、`bash 10.6`、`core 10.6`、`fabric 7.3` …                       |
| **合计**            | **1755**    | **8609**   | 100%  |                                                                                 |

### 3.2 Tier 1 / Tier 2 划分（按 AGENTS.md「Test tiers and flake triage」）

映射口径（[I]，按 AGENTS.md 的举例机械落地）：Tier 2 = `tests/secure/**`、`tests/conformance/**`（自门控 conformance）、`tests/integration/**`（真实子进程），外加任何路径含 `web-hub-spawn` / `external-droid` / `web-hub-headless` / `bash-crash-recovery` / `cache-keepalive` / `schedule-fault-matrix` / `web-hub-lan` 的文件；其余全部 Tier 1。

| 层         | 文件数 | worker-s | 占 worker-time | 平均        | 分布                                                              |
| ---------- | ------ | -------- | -------------- | ----------- | ----------------------------------------------------------------- |
| **Tier 1** | 1524   | **1057** | **12.3%**      | 0.69 s/文件 | <0.5 s：1309 · 0.5–2 s：132 · 2–10 s：64 · 10–30 s：20 · >30 s：4 |
| **Tier 2** | 231    | **7552** | **87.7%**      | 32.7 s/文件 | <0.5 s：101 · 0.5–2 s：40 · 2–10 s：31 · 10–30 s：21 · >30 s：33  |

折算墙钟（4 worker，[I]）：Tier 1 全跑 ≈ 264 s + collect/prepare ≈ **5–7 min**；除 `tests/secure`+`tests/conformance` 之外全部 ≈ **661 s ≈ 11 min**；全量 2347 s。

### 3.3 前 30 慢文件与"为什么慢"分类

| #   | 文件                                            | 耗时     | 打印用例耗时      | 慢的原因类别                                                                                           |
| --- | ----------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `tests/secure/launcher-convert.test.ts`         | 2175.4 s | 2175.1 s（42/44） | 真实挂载 + **失败路径**：`foreign` ⇒ 74 ⇒ 90 s seam 轮询 ×8 + 674 s 单例（锁 590 s + 用例体） [F]      |
| 2   | `tests/conformance/secure-convert.test.ts`      | 582.4 s  | 0 s               | **锁等待**（560 s 预算耗尽 ⇒ 套件级失败）                                                              |
| 3   | `tests/conformance/secure-convert-xc89.test.ts` | 382.5 s  | 0 s               | 锁等待（560 s 预算，未耗尽即拿到）                                                                     |
| 4   | `tests/integration/web-hub-headless.test.ts`    | 310.2 s  | 308.7 s（28/36）  | 真实 hub 子进程 ×312 处 spawn + 真实升级阶梯（+5 s TERM、+3 s KILL、reaper ≤14 s）+ 7 处 ≥1 s 静态等待 |
| 5   | `tests/secure/launcher-off-golden.test.ts`      | 277.6 s  | 26.0 s            | 锁等待 240 s + 真实挂载 golden                                                                         |
| 6   | `tests/secure/convert-state.test.ts`            | 255.3 s  | 171.1 s（71/103） | 真实挂载：103 例，每例 1.7–4.8 s（对照干净复跑 191 s）                                                 |
| 7   | `tests/secure/helper-v0-api.test.ts`            | 252.2 s  | 1.1 s             | 锁等待 240 s                                                                                           |
| 8   | `tests/secure/launcher-private.test.ts`         | 249.4 s  | 0 s（21 skip）    | 锁等待 240 s                                                                                           |
| 9   | `tests/secure/launcher-fuse.test.ts`            | 249.0 s  | 0 s（18 skip）    | 锁等待 240 s                                                                                           |
| 10  | `tests/secure/init-cleanup-real.test.ts`        | 236.5 s  | 236.5 s（4/4）    | 真实 gocryptfs；单个用例 216.7 s（`gocryptfs -init` 口令不一致的等等待）                               |
| 11  | `tests/conformance/secure-gocryptfs.test.ts`    | 178.5 s  | 2.3 s（1/6）      | 锁等待 + `scripts/dev/secure-probe.sh`（内部 170 s 超时）                                              |
| 12  | `tests/conformance/secure-convert-xc2.test.ts`  | 178.3 s  | 0.7 s（1/10）     | 锁等待（唯一打印用例 721 ms）                                                                          |
| 13  | `tests/secure/launcher-private-unit.test.ts`    | 175.2 s  | 23.7 s（18/128）  | 真实挂载/lease/进程（对照组：干净复跑 26 s ⇒ **本轮 150 s 是争用**）                                   |
| 14  | `tests/secure/launcher-private-cmd.test.ts`     | 156.2 s  | 34.6 s（11/42）   | 同上（590 s 锁预算 + 真实 unshare）                                                                    |
| 15  | `tests/secure/launcher-v6-wiring.test.ts`       | 155.4 s  | 2.1 s（3/34）     | 锁等待 240 s                                                                                           |
| 16  | `tests/conformance/secure-private-ns.test.ts`   | 149.5 s  | 0 s               | 锁等待（真实 unshare 块）                                                                              |
| 17  | `tests/governance/bundle-parity.test.ts`        | 147.0 s  | 131.9 s（8/28）   | 真实子进程：每个矩阵行一个 tsx/loader 子进程 + 三次 `loadExtensions` 全量装载                          |
| 18  | `tests/integration/fabric-xs-alias.test.ts`     | 94.0 s   | 94.0 s            | 真实 hub 子进程 + 真实 socket + 固定 5.2 s 等待 ×4（`pairMinIntervalMs`）                              |
| 19  | `tests/integration/fabric-xs-alias-v2.test.ts`  | 93.2 s   | 93.2 s            | 同上                                                                                                   |
| 20  | `tests/integration/fabric-xs-mention.test.ts`   | 86.3 s   | 86.3 s            | 同上                                                                                                   |
| 21  | `tests/integration/fabric-xs-reply.test.ts`     | 85.6 s   | 85.6 s            | 同上                                                                                                   |
| 22  | `tests/integration/web-hub-feishu-bot.test.ts`  | 85.2 s   | 85.2 s            | 真实 socket/进程 + 固定等待                                                                            |
| 23  | `tests/integration/fabric-xs-channel.test.ts`   | 77.7 s   | 77.7 s            | 真实 hub + 固定等待                                                                                    |
| 24  | `tests/secure/archive.test.ts`                  | 55.1 s   | 30.0 s（21/121）  | 真实 gocryptfs（含 10.3 s 的 `mount.lock` 等待用例）                                                   |
| 25  | `tests/integration/fabric-thread-e2e.test.ts`   | 52.0 s   | 52.0 s            | 真实 hub + 4 处 ≥1 s 静态等待                                                                          |
| 26  | `tests/integration/fabric-xs-lifecycle.test.ts` | 50.4 s   | 50.4 s            | 真实 hub + 固定等待                                                                                    |
| 27  | `tests/integration/fabric-xs.test.ts`           | 49.9 s   | 49.9 s            | 真实 hub + 固定等待                                                                                    |
| 28  | `tests/conformance/fabric-xs.test.ts`           | 46.7 s   | 44.9 s（3/27）    | 真实 px/协议 + 2 处 ≥1 s 等待                                                                          |
| 29  | `tests/web-hub/ui/logic-markdown-perf.test.ts`  | 43.2 s   | 43.1 s（13/14）   | **性能迭代型**（阈值/基线测量，非睡眠）                                                                |
| 30  | `tests/web-hub/hub/feishu/service.test.ts`      | 42.0 s   | 41.9 s（33/34）   | 真实 sqlite/socket/进程                                                                                |

类别归并（按 worker-time）：**真实挂载**（secure + conformance/secure）≈ 5823 s；**锁等待/空转**（并发副产物）≈ 1600 s；**真实子进程/真实 socket**（integration + governance + release）≈ 1800 s；**固定 sleep**（`fabric-xs*` 家族里的 5.2 s 与 400 ms 轮询）为主要放大器；**性能迭代**（markdown-perf 43 s、`core` 的 P1–P14 各 1000 序列 ≈ 8.5 s）量级最小。 [F]/[I]

### 3.4 长尾结构（决定墙钟的是"极少数文件"）

| 累计   | worker-s | 占比 |
| ------ | -------- | ---- |
| Top 4  | 3451     | 40%  |
| Top 9  | 4734     | 55%  |
| Top 14 | 5659     | 66%  |
| Top 19 | 6298     | 73%  |
| Top 29 | 6930     | 80%  |
| Top 49 | 7504     | 87%  |
| Top 99 | 8068     | 94%  |

其余 1656 个文件合计 541 s。⇒ **任何"整理小文件"的优化都撬不动大局**。 [F]

---

## 4. Q3 — `collect 396.9 s` / `prepare 95.2 s` 为什么偏高

**先看量级**：collect 占 worker-time 4.6%、prepare 1.1%；即使全归零，墙钟最多省 ~(397+95)/4 ≈ 123 s（2347 → ~2224 s）。**不是主因。** [F]

**prepare ≈ 逐文件固定开销**：`95.24 s / 1755 ≈ 54 ms/文件`；实测单文件运行也是 `prepare 52–56 ms`（附录 A 的 4 次测量）。来源是 `setupFiles: ./tests/setup/sandbox-home.ts`（`vitest.config.ts:29`）：它在**每个 worker、每个文件**都要被求值，且 `import()` 了 `src/core/agent-dir.js`、`src/web-hub/protocol/paths.js`（`tests/setup/sandbox-home.ts:9-22`），随后**改写全局 `fs.*` / `net.*` / `child_process.*`**（`:86-146`，9 个 fs 同步方法 + 4 个网络/进程方法）。⇒ 固定 54 ms 几乎无法再降，除非不隔离（`--no-isolate`）或合并文件。 [F]

**collect 的分布**（实测，附录 A）：

| 样本                               | 文件                                                          | transform                      | collect                     | 说明                                      |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------ | --------------------------- | ----------------------------------------- |
| 极小文件                           | `tests/goal/command.test.ts`（17 行）                         | 113 ms                         | **41 ms**                   | 每文件地板 ≈ 0.39 s 总耗时                |
| web-hub 浅模块                     | `tests/web-hub/agent/alias-status.test.ts`（18 行）           | 92 ms                          | **12 ms**                   | 只要不进口 `src/index.js` 就很便宜        |
| **`import src/index.js`**          | `tests/web-hub/agent/input-order.test.ts`                     | 4.86 s                         | **6.83 s**                  | 整棵扩展图（1272 个 src 文件 / 376 k 行） |
| 同上                               | `tests/integration/child-extension-activation-signal.test.ts` | 4.59 s                         | **6.51 s**                  | 复现                                      |
| 两个重型文件，2 worker（各自冷启） | 上述两个                                                      | 4.55 s                         | **12.83 s**（= 6.4 + 6.4）  | 并行也不复用                              |
| 两个重型文件，**1 worker 顺序**    | 上述两个                                                      | 4.58 s（**缓存复用，未翻倍**） | **8.01 s**（第二个 ≈1.6 s） | 复用只省 collect，不省首启 transform      |

⇒ **collect 的大头是 48 个 `import …/src/index.js` 的文件**（其中 42 个在 Tier 2 目录；Tier 1 只有 6 个）：冷启 ~6.5 s/文件，同 worker 热态 ~1.6 s/文件；48 × 1.6–6.5 ≈ **77–310 s**，正好覆盖 397 s 的绝大部分。剩下 1700 个文件的 collect 平均只有几十 ms。 [F]/[I]

**与 vue 插件的关系**：`plugins: [vue()]`（`vitest.config.ts:13`）与 `uiAliases`（`:14`）对所有文件生效，但只有 `src/web-hub/ui/**` 的 128 个 `.vue` 需要它；实测 web-hub 浅模块 collect 12 ms ⇒ **vue 插件不是 collect 的主要成本**。 [F]

**环境/home 沙箱**：`environment: "node"`（`:27`）、`environment 38.26 s`/1755 ≈ 22 ms/文件，可忽略。 [F]

---

## 5. Q4 — 现有脚本与流程

### 5.1 `package.json` scripts（只列测试相关）

| script                                                                              | 内容                                                                    | 过滤能力                                                                                         |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `test`                                                                              | `vitest run`                                                            | 全量（含 `tests/conformance`，因为 `include` 是 `tests/**/*.test.ts`，`vitest.config.ts:26`）[F] |
| `test:watch`                                                                        | `vitest`                                                                | —                                                                                                |
| `test:conformance`                                                                  | `vitest run tests/conformance`                                          | **目录级过滤**（`tests/conformance` 38 文件 / 1613 s ⇒ 单独跑仍会带上 5 个 secure 文件） [F]     |
| `test:traffic-gate`                                                                 | `PI_TRAFFIC_PERF_GATE=1 vitest run tests/traffic/db-contention.test.ts` | 单文件 + 环境变量门                                                                              |
| `build` / `build:web` / `check:web` / `build:bundle` / `typecheck` / `format:check` | 门禁的其它部分                                                          | —                                                                                                |

### 5.2 `scripts/release/release.sh`

- `:547-556`：先 `build` / `build:web` / `check:web`，再 `PI_TOOLKIT_TEST_WORKERS="${PI_TOOLKIT_TEST_WORKERS:-4}" npm test`（**全量，无过滤**）；`--skip-tests` 仅应急。 [F]
- 注释明确"time is cheap there, while timing-sensitive integration tests flake under CPU contention" ⇒ 4 worker 是**故意压低**的。 [F]

### 5.3 `.github/workflows/ci.yml`

- 单个 `test` job（matrix 只按 node 版本），顺序：`format:check` → `typecheck` → `build:web`+`check:web` → `build:bundle` → **`npm test`（全量）** → `build`；`env: PWH_REQUIRE_UI_DIST=1, PI_TOOLKIT_TEST_WORKERS: "2"`（`:44-50`）。 [F]
- 没有 `test:conformance` 独立步骤、没有 shard、没有拆分 job。 [F]
- **CI 上 real-mount 套件会自跳过**：runner 没有 gocryptfs/fusermount3 ⇒ `realSkipReason()` 非空、`HAVE_FUSE_STACK=false`（纯逻辑用例不受影响）。所以 CI 的 `npm test` 只覆盖"非 real-mount"部分，那 68% 的耗时/覆盖**只在本地发版前发生**。 [I]（依据：自门控只探测二进制与 `/dev/fuse`，`private-real-harness.ts:47-58`、`secure-gocryptfs.test.ts:53-58`）
- 另有 `web-min-node` job：`build:web` + `check:web` + `node scripts/traffic/node-floor-smoke.mjs`（<1 s）。 [F]

### 5.4 `vitest.config.ts` 关键项

| 项            | 值                                                  | 备注                                                                              |
| ------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `include`     | `tests/**/*.test.ts`, `tests/**/*.test-d.ts`        | 无 `exclude`；无 `projects`/`workspace` 文件（`ls vitest.workspace.*` 不存在）[F] |
| `environment` | `node`                                              |                                                                                   |
| `globalSetup` | `tests/setup/global-tz.ts`（钉 `TZ=Asia/Shanghai`） | 每轮 1 次，廉价 [F]                                                               |
| `setupFiles`  | `tests/setup/sandbox-home.ts`                       | 每文件 ~54 ms（§4）[F]                                                            |
| `testTimeout` | `10_000`                                            | 单文件可覆盖到 90 s/280 s/430 s/600 s（§2.3d）[F]                                 |
| `maxWorkers`  | `PI_TOOLKIT_TEST_WORKERS` 或 `min(8, cores-1)`      | 注释记录 2026-10-15：该机 8 vs 15 worker 都是 ~210 s [F]                          |
| `minWorkers`  | 1                                                   |                                                                                   |
| 池            | 默认 `forks`，`isolate` 默认 true                   | 未显式配置 [F]                                                                    |

### 5.5 已有过滤手段盘点

| 手段                    | 现状                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 目录/路径过滤           | ✅ 只有 `test:conformance`、`test:traffic-gate` 两个 npm script；其余靠手敲路径                                |
| `--shard`               | ❌ 未使用（vitest 2.1.9 支持，`npx vitest --help` 确认）[F]                                                    |
| workspace / `--project` | ❌ 无 workspace 配置（2.1.9 的机制是 `--workspace` + `--project`）[F]                                          |
| tag / `slow` 组         | ❌ 无（`docs/dev/traffic-merge/plan.md:413` 提到"#8/#10 不标 `slow` 组"，说明该机制当时就被讨论过但未落地）[F] |
| per-file `testTimeout`  | ✅ 单个用例/套件已在用（不是过滤，但能防长尾）                                                                 |

### 5.6 拆分 Tier 2 独立脚本对 CI / 发版的影响（事实层）

- **CI**：现在的 `npm test` 在 runner 上已经把 secure 自跳过了；拆出去对 CI 的**实际耗时几乎无影响**（但会让"哪些套件在 CI 从不运行"显式化，可另开 job 或在受控环境跑）。 [I]
- **发版（`release.sh`）**：`npm test` 是唯一门禁；若把 Tier 2 拆成独立脚本，release.sh 必须**两者都跑**，否则等于放宽发版门禁（AGENTS.md 的 release 规则要求"Tier 1 必绿 + Tier 2 按 triage 解释"）。 [I]
- **本机日常**：拆分能让"改一个小模块"的验证成本从 39 min 降到 Tier 1 的 5–7 min，这是唯一明显的收益点。 [I]

---

## 6. Q5 — 可选提速手段的初步评估（只列事实与数量级）

| 手段                                                                | 已知事实                                                                                                                                                                        | 数量级 / 边界                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **先把测量环境弄干净**（不留残进程、不并发两轮、不留残留挂载）      | 本轮 8609 s 里约 **1600 s** 是锁等待/空转；`launcher-convert` 的 2175 s 里约 **1000 s** 是"失败路径烧满预算"（90.1 s ×8 + 674 + 121 + 112 + 111 ≈ 1800 s，其中至少一半是等待）  | 干净单轮估计 **25–30 min**（对照：`convert-state` 干净复跑 191 s vs 本轮 255 s）[F]/[I]                                                                                                                                                                 |
| **符号链接布局修复**（`physicalPaths` 与挂载路径拼写一致）          | 现场 mountinfo 与 cmdline 拼写不同（§2.3b）                                                                                                                                     | 只影响 `launcher-convert`：单独一文件 **2175 s → 约 250 s** 量级（按其余用例 1.5–5 s/例 + 8 个真 pause 用例）[I]                                                                                                                                        |
| **vitest workspace/projects 拆分（Tier 1 / Tier 2）**               | 无 workspace 配置；Tier 1 = 1524 文件 / 1057 s                                                                                                                                  | Tier 1 单跑 ≈ **5–7 min**；Tier 2 单跑 ≈ 7000 s/4 ≈ **29 min** [I]                                                                                                                                                                                      |
| **`--shard`（CI 多 job）**                                          | vitest 2.1.9 支持；CI 现为单 job                                                                                                                                                | 2 shard ⇒ 每个 job 约一半 worker-time；但**同机并行的 gocryptfs 锁不能被跨 job 串行化**（flock 只在同机生效），跨机反而天然安全 [I]                                                                                                                     |
| **worker 数**                                                       | 4 worker 实测 2347 s vs 理想 2152 s（差 8%）；配置注释：8 与 15 worker 在 2026-10 都是 ~210 s                                                                                   | 可回收 **≤8%**；长尾由单文件 2175 s 决定（`maxWorkers` 再大也不能切开一个文件）[F]                                                                                                                                                                      |
| **`--no-isolate`**                                                  | 实测：两个重型文件同 worker 顺序执行时 collect 8.01 s（第二个 1.6 s）vs 两个冷 worker 12.83 s                                                                                   | 对 48 个 `src/index.js` 文件最多省 ~50–70% 的 collect（≈200–300 s worker-time = ~60 s 墙钟）；**风险**：本仓大量依赖 `activate()` 一次注册、`Symbol.for` 全局、env/HOME 沙箱（`sandbox-home.ts`），跨文件复用模块注册表会直接破坏 I2/I4/I6 前提 [F]/[I] |
| **secure 单独脚本 + 显式门控**                                      | 已有可复用门控原语 `realSkipReason()`（`:47-58`）；`launcher-private` 已有"等 60 s 再 skip"的先例（`:523-536`）                                                                 | 不减少耗时，但能把 **68% 的耗时从"每次全量"里摘出来**，并让"环境脏"变成一次性提示而不是逐例烧预算 [I]                                                                                                                                                   |
| **缓慢用例 fake timers 化**                                         | 26 个文件里 **55 处 ≥1 s 的静态等待**；`fabric-xs*` 家族 6 处 5.2 s（`pairMinIntervalMs`），29 文件合计 739 s；`until()` 轮询是 50 ms 粒度（`private-real-harness.ts:453-464`） | `fabric-xs` 家族理论可压到 ~1/3（739 s → ~250 s）**若**把 hub 时钟注入（`fabric-xs-alias` 已用 `StartHubDeps.now` 注入时钟的先例，见该文件头注释）；secure 的 90 s/590 s 轮询不能 fake —— 它们等的是**别的进程**的副作用 [F]/[I]                        |
| **把 `governance/bundle-parity` 与 `release/package-zip` 移出全量** | 147 s + 36 s，均需 `dist/` 构建产物 + tsx 子进程                                                                                                                                | 合计 183 s worker-time（≈46 s 墙钟）；二者都依赖"先 build"的顺序（`ci.yml:34-40`），移出会改变门禁顺序语义 [F]                                                                                                                                          |
| **`tests/web-hub`（754 文件 / 627 s）**                             | 平均 0.83 s/文件，无 >50 s 文件                                                                                                                                                 | 收益来自 collect/prepare 的固定成本，不是单文件；量级 ≤100 s [F]                                                                                                                                                                                        |

---

## 7. 未解决 / 待确认

1. **`tests/integration/stack-teardown-matrix.test.ts` G10 真失败**：`AssertionError: expected [ { …(3) } ] to deeply equal []`（`/tmp/batch-test.log:6805-6820`）——与本主题无关，但被并发运行掩盖，需单独复核。 [F]
2. `launcher-convert` 的 **674 s 单例**（`§7.2-4 rollback while the new vault is busy`）我归因为"590 s 锁等待 + 84 s 用例体"，**未直接验证**（无单例阶段日志）。 [I]
3. `launcher-off-golden` 为什么"既有 26 s 打印用例、又在 `beforeAll` 失败"，日志未给阶段信息，未查清。 [I]
4. `tests/secure/init-cleanup-real.test.ts` 的 216.7 s 单例（`① gocryptfs -init fails（两次口令不一致）`）是"等待某超时"还是"真实 IO 慢"，未深入。 [I]
5. `/tmp/rerun-secure.log` 在 14:05 仍在写（`launcher-convert` 未见完成，`timeout 1500` 已近耗尽）⇒ **它的最终汇总与 `launcher-convert` 在隔离条件下的耗时还未知**，这是"2175 s 里有多少是争用、有多少是 intrinsic"的关键数据，建议复跑结束后补读。已读到的 6 个文件：`launcher-private-unit 26.1 s`、`archive 44.1 s`、`convert-state 191.2 s`、`tree 9.9 s`、`launcher-helper 4.7 s（1 失败：符号链接拼写）`、`launcher-private-cmd 610.7 s（≈590 s 等锁）`。 [F]
6. 仍有一个失败运行留下的**全局 gocryptfs 挂载**（`/tmp/ps-v7mnt-8L2M3o/proj`，来自 `v7lD1qdy`）：它会让后续 `launcher-private` / `launcher-v6-wiring` 的用例**每例静默 skip（60 s/例）**。需要人工 `fusermount3 -u`（本文未执行，避免干扰在跑的那轮）。 [F]

---

## 附录 A — 本次实测命令（均为非 secure 单文件，可重放）

```sh
npx vitest run tests/goal/command.test.ts                       # → 394 ms (collect 41 ms, prepare 55 ms)
npx vitest run tests/web-hub/agent/alias-status.test.ts         # → 363 ms (collect 12 ms, prepare 55 ms)
npx vitest run tests/web-hub/agent/input-order.test.ts           # → 7.25 s (transform 4.86 s, collect 6.83 s)
npx vitest run tests/integration/child-extension-activation-signal.test.ts  # → 6.90 s (collect 6.51 s)
npx vitest run tests/web-hub/agent/input-order.test.ts tests/integration/child-extension-activation-signal.test.ts              # 2 worker → 6.81 s, collect 12.83 s
npx vitest run --maxWorkers=1 --minWorkers=1 tests/web-hub/agent/input-order.test.ts tests/integration/child-extension-activation-signal.test.ts  # → 8.62 s, collect 8.01 s
```

只读环境探测：`which gocryptfs fusermount3 …`、`gocryptfs -version`、`ls -l /dev/fuse`、`mount | grep -i gocryptfs`、`ls -ld /tmp/v-batch/node_modules`、`stat -c '%d:%i' /tmp/pi-secure-gocryptfs-tests-1001.lock`、遍历 `/proc/[0-9]*` 统计不可读 `cwd` 的同 uid 进程、比对 `/proc/<pid>/cmdline` 与 `/proc/self/mountinfo`。

日志解析脚本（一次性，放在 `/tmp`，不入库）：`/tmp/parse-vitest.mjs`（逐文件耗时）、`/tmp/tiers.mjs`（Tier 汇总/累计占比）、`/tmp/attr.mjs`（文件耗时 vs 打印用例耗时之差）。

## 附录 B — 关键代码坐标

| 事实                                                   | 坐标                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| 跨套件 gocryptfs 锁（240 s 默认预算、`holder exit 1`） | `tests/secure/gocryptfs-test-lock.ts:1-30, 63, 106`      |
| `launcher-convert` 每例取锁 590 s / 用例超时 600 s     | `tests/secure/launcher-convert.test.ts:429-437`          |
| 90 s seam 轮询                                         | `tests/secure/launcher-convert.test.ts:389-392`          |
| 50 ms 粒度 `until()`                                   | `tests/secure/private-real-harness.ts:453-464`           |
| scratch 根落在 `node_modules/.cache/v7`                | `tests/secure/launcher-convert.test.ts:76-84`            |
| harness 默认根 `/tmp`（对照）                          | `tests/secure/private-real-harness.ts:200-205`           |
| 自门控 `realSkipReason()`                              | `tests/secure/private-real-harness.ts:47-58`             |
| "外来挂载 ⇒ 60 s 后 skip"                              | `tests/secure/private-real-harness.ts:523-536`           |
| conformance 自门控 `HAVE_FUSE_STACK`                   | `tests/conformance/secure-gocryptfs.test.ts:53-58, 81`   |
| 挂载用原样路径                                         | `src/secure/bin/helper.mjs:3080`                         |
| 校验用 realpath（`source !== realCipher ⇒ foreign`）   | `src/secure/bin/helper.mjs:282-287, 320-350`             |
| `foreign` 报错点                                       | `src/secure/bin/helper.mjs:3089-3092, 2505`              |
| 不可检查同 uid 进程的确认门（2026-10-24）              | `src/secure/bin/convert.mjs:1008-1060`（提示在 `:1052`） |
| vitest include / setupFiles / testTimeout / maxWorkers | `vitest.config.ts:26, 28-29, 30, 37`                     |
| HOME 沙箱改写全局 fs/net/child_process                 | `tests/setup/sandbox-home.ts:86-146`                     |
| CI 全量 `npm test` @2 worker                           | `.github/workflows/ci.yml:44-50`                         |
| 发版全量 `npm test` @4 worker                          | `scripts/release/release.sh:547-556`                     |
