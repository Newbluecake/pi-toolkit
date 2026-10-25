# N4 报告 — `run --private` e2e + conformance

范围：private-plan r3 §6.2（启动器 e2e，含 6a B1 闸门、6b B2）、§6.3（NC1–NC12 + NC2b/NC2c，探针 `CHECK` 行、`--fast` 零请求）、§7.1 N4 行，以及 N1/N2 报告里标「归 N4」的项。分支 dev（N0+N1 3c53c3fd、N3 0f2a386a、N2 ed33894e 之上），未提交。

## 1. 改动清单

| 文件                                          | 性质                        | 说明                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/secure/private-real-harness.ts`        | 新                          | 真机 e2e 共用基座：临时 HOME + 新布局保险库、假 pi（env 驱动：事实记录、睡眠/退出码、写数据、`setsid` 遗留 job、忽略 TERM 的成员、`--lazy` 对照进程、忽略 SIGHUP、从会话内部执行 `pi-secure` 的触发器、信号事件记录）、script(1) 口令驱动、`/proc` 工具。清理按归属授权（评审 #1/#2）：随机 token `PI_TOOLKIT_TEST_RUN`、`owned()`、`killOwned()`、`killGroup()`，见「§安全评审处置」 |
| `tests/secure/launcher-private.test.ts`       | 新                          | §6.2 e2e，21 个用例，持 gocryptfs 测试锁，自门控                                                                                                                                                                                                                                                                                                                                      |
| `scripts/dev/secure-ns-probe.sh`              | 重写                        | 生产启动器驱动的 conformance 探针，输出 `CHECK <id> PASS\|FAIL\|KNOWN <detail>`，`--fast` 跳过真 pi 项。POSIX sh 外壳 + 内嵌 Node 程序（`sh`/`bash` 都能跑）。调研版探针在 git 历史 ed33894e，结论仍在 `private-ns-probe.md`                                                                                                                                                          |
| `tests/conformance/secure-private-ns.test.ts` | 新                          | 全量模式跑探针，逐个 NC id 断言（NC9 必须 KNOWN，其余必须 PASS），断言无残留                                                                                                                                                                                                                                                                                                          |
| `src/secure/bin/helper.mjs`                   | 测试缝 +21 行；F1 修正 1 行 | 见 §5 实现修正                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/secure/private-real-harness.test.ts`   | 新                          | 清理授权自测：无 token 的同路径进程不被杀、token 之外还要求起始时间、复用 pid/非组长/过期 tracked 零信号（kill spy）                                                                                                                                                                                                                                                                  |
| `tests/secure/launcher-private-unit.test.ts`  | 改                          | 状态表矩阵与 r3.1 同步：session 需要 supervisor 存活；新增 F1 四种组合                                                                                                                                                                                                                                                                                                                |
| `tests/conformance/secure-gocryptfs.test.ts`  | 改                          | C1–C3 块持 gocryptfs 测试锁（验收 Blocker：它经 secure-probe.sh 建全局挂载）                                                                                                                                                                                                                                                                                                          |
| `docs/dev/data-encryption/private-plan.md`    | 改                          | §3.3 状态表 session 行 + 「r3.1 修订（N4 F1，主会话裁定）」注                                                                                                                                                                                                                                                                                                                         |

冻结面：N0 golden、secure-off golden、三个 fabric off golden、parity fixture 都没动。

## 2. §6.2 条目 → 测试

L = `tests/secure/launcher-private.test.ts`（本包）；U = `launcher-private-unit.test.ts` 真机冒烟块（N1）；C = `launcher-private-cmd.test.ts` 真机块（N2）。

| §6.2 | 内容                                 | 落点                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 正路径                               | L「happy path」：真实 uid / CapEff 0 / fd 9 / cwd=work；会话中外部看哨兵、全局 mountinfo 无条目、租约 held、`grep -r` 找不到 canary、`status` 为 `private`；退出码透传 7；记录删除、租约空闲、普通挂载读回数据。U「normal exit」另测 ns 不同、P0 释放 <1 s                          |
| 2    | 遗留成员                             | U「leftover member」                                                                                                                                                                                                                                                                |
| 3    | 互斥                                 | L「mutual exclusion」：同库全局挂载 76、另一库全局挂载 76（均无口令提示）；会话中普通 `run`、第二个 `run --private`、ns 内 `lock --kill` 都 76。C：会话中 `unlock` 76。U：Q10 / 继承挂载                                                                                            |
| 4    | lock 各参数 + launching 窗口         | L「launching window」（测试缝让挂载后检查停 4 s）：`lock`、`lock --lazy` 76，会话照常跑完；L「--kill in launching」：0，run 以「已中止」退出 1，pi 从未启动。L「finalizing wait」（N2 残留）：`lock` 等待后 0。C：会话中 `--kill`/`--lazy`                                          |
| 5    | `--lazy` 控制组                      | L「--lazy control group」：已打开 fd 与 cwd 在挂载内的后台进程 lazy 后仍读到明文（R29，照实断言），绝对路径新访问 ENOTDIR/ENOENT；插件 LOCKED 复检的依据（会话 ns 的 mountinfo 已无该挂载）用 `vaultMountState` 断言；会话继续，收尾终止控制进程                                    |
| 6    | 崩溃                                 | SIGKILL P1：U；SIGKILL P0+P1：L 6a；前台进程组 SIGKILL：L（gocryptfs setsid 存活 ⇒ `private:orphan`，`unlock`/`run --private` 76，`lock` 外部收尾 0）；删除记录：L（`lease:unrecorded`，入口拒绝，`lock --kill` 不杀，会话照常结束）；bootId：C（假实例）                           |
| 6a   | B1 闸门                              | L「6a B1 gate」，(a)(b)(c)(d) 全套，偏离见 §6                                                                                                                                                                                                                                       |
| —    | 「P1 被杀后由 gocryptfs 单独持租约」 | L「P1 killed: gocryptfs ALONE holds the lease」：杀 P0/P1/pi 后，持有租约的只有 gocryptfs（和它自己的 `logger` 子进程，见 §4-2），`/proc/<g>/fd/9` = 租约；普通 `unlock` 与新 `run --private` 都 76 无提示；杀掉 gocryptfs 后租约释放、`stale-record`、`lock` 0。探针 NC2 再测一遍  |
| 6b   | B2                                   | 正常路径 <1 s：U。L「6b B2」：P0 被 SIGSTOP ⇒ P1 写 `inNsDone`、带 pi 退出码退出，记录留下 ⇒ `stale-record` ⇒ 下次 `run --private` 清理后继续，退出码 5                                                                                                                             |
| 7    | 非零退出                             | L：pi exit 1、127 透传，正常收尾。「P1 自检失败 exit 1」走 U 的纯函数 / 假实例（`no ns ⇒ release, 69`）                                                                                                                                                                             |
| 8    | 有界                                 | L「worker timeout」：readdir 探活 worker 超过 3 s 预算 ⇒ 检测为超时、75、pi 不启动、<12 s、已释放（评审 #4）；L「TERM-ignoring member」⇒ KILL；L「gocryptfs SIGSTOP at end」⇒ TERM/KILL 路径，ns 内收尾 <12 s；L「WORST PATH」≤22 s（见下）；L「mount.lock held」⇒ 73，无提示无记录 |
| 9    | 参数被拒                             | L：`--session-dir` / `--no-extensions` / `--export` ⇒ 64，无认领、无提示、无记录                                                                                                                                                                                                    |
| 10   | `init --private`                     | C                                                                                                                                                                                                                                                                                   |

**最坏路径 e2e（≤22 s）**：测试缝 `PI_SECURE_TEST_FINALIZE_STALL_MS=30000` 让 P1 的 ns 内收尾一进来就卡住，同时 gocryptfs 被 SIGSTOP。从 pi 退出起计时：P1 的 10.5 s 硬后备触发（「ns 内收尾未完成」，75），P0 判外部收尾（「执行外部收尾」），TERM→KILL 停住的 gocryptfs（「已终止 pid N gocryptfs」），经释放协议删记录，退出码为 pi 的 143。断言 10 s < 总时长 ≤ 22 s，实测约 13.7 s。

「worker 超时」与「P1/P0 收尾兜底」是两份独立证据（评审 #4）：

- **worker 超时**（L「worker timeout」）：`PI_SECURE_TEST_WORKER_DELAY=readdir:15000` 让真实的生产 worker（挂载后探活 `readdir`，预算 `readyMs` 3 s）睡过预算。断言：exit 75、文案「挂载内操作 readdir 超时」、pi 从未启动、总时长 <12 s（远小于 15 s）、记录删除、租约空闲、无全局挂载。防回归论证（已实测）：把 `runWorker` 的截止接线改成 `deadline: Date.now() + ms * 1000`（等于撤掉预算），worker 睡满 15 s 后成功，pi 启动，退出码不是 75，用例在 16 s 处失败；恢复后通过。ns 内收尾本身不经 worker（它直接用有界的 `umount -n`），所以 worker 超时只能放在挂载阶段验证。
- **收尾兜底**（L「WORST PATH」）：上面的 stall 缝让 P1 的 ns 内收尾卡住，验证的是 10.5 s 硬后备 → P0 外部收尾 → ≤22 s。只 SIGSTOP gocryptfs、不用测试缝时，ns 内收尾自己在 <12 s 内完成（L「gocryptfs SIGSTOP at end」），这条链在本机只能靠测试缝稳定复现；测试缝只延时，不改任何判定。

N1/N2 归 N4 项的去向：launching 窗口 lock、`--lazy` 控制组、前台进程组 SIGKILL、≤22 s 端到端、6a 全套、NC1–NC12 + `CHECK` 行、launching 中 `--kill`、finalizing 等待都已覆盖。「lock 发起的 orphan 外部收尾」由前台进程组用例覆盖。「lock 发起的 orphan-ns 外部收尾」在 r3.1 修正后由 L「r3.1 F1」用例覆盖（§4-4）。

## 3. Conformance：NC → `CHECK`

`sh scripts/dev/secure-ns-probe.sh [--fast]`。本机（kernel 5.15、util-linux 2.37.2、gocryptfs 1.8.0、Node 22.22.1、pi 1.3.0）全量结果：`SUMMARY pass=13 fail=0 known=1 skip=0`；`--fast`：`pass=12 fail=0 known=1 skip=1`（NC10 输出 `SKIP NC10 --fast …`）。

| NC   | 结果  | 探针怎么测（节选实测 detail）                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NC1  | PASS  | `unshare --help` 含六个所需参数；userns 内 tmpfs 挂载成功，外部不可见                                                                                                                                                                                                                                                                                                                                         |
| NC2  | PASS  | 生产链（启动器 → `sh exec 9<>; flock -n 9` → unshare → Node P1 → `spawn gocryptfs -fg`）：setsid 后的 TTY 口令被接受；到达 `session` 即 P1 收到 notifypid 的 SIGUSR1；gocryptfs 与 P1 同 mnt ns、`sid==pid`、`/proc/<g>/fd/9` = 租约。SIGKILL P0+P1+pi 并确认 shell 链（exec 后即 P1）已不在后：租约持有者只有 gocryptfs 及其子进程，`/proc/locks` 按 inode 有条目，`flock -n` 被拒；gocryptfs 退出后条目消失 |
| NC2b | PASS  | 在 pty 上发 ^C：gocryptfs（setsid）与 P0/P1 都不受影响；假 pi 自己处理 SIGINT、1.5 s 后退出 130，正常收尾，状态干净。真 pi 的 ^C 行为属于 pi 自身；用假 pi 是为了 `--fast` 下也能离线跑                                                                                                                                                                                                                       |
| NC2c | PASS  | 普通 `unlock`：守护进程（ppid 1，不是 shell 链）持有租约 fd，`/proc/locks` 有条目；`lock` 后条目消失、租约空闲                                                                                                                                                                                                                                                                                                |
| NC3  | PASS  | 内层 uid/gid 为真实值、CapEff 0；内层 `umount` 保险库失败（exit 32 "must be superuser"）；`nsenter --mount=/proc/<宿主 pid>/ns/mnt` 失败（Permission denied）                                                                                                                                                                                                                                                 |
| NC4  | PASS  | 外部：哨兵完好（0 字节 0400，只有 work/state）、全局 mountinfo 无条目、`grep -r` 在保险库目录/挂载点/临时 HOME 里都找不到 canary                                                                                                                                                                                                                                                                              |
| NC5  | PASS  | 外部读 `/proc/<pi>/mountinfo`：`fuse.gocryptfs`，source == realCipher；另一库的全局挂载被复制进新建的 ns（Q10 的依据）                                                                                                                                                                                                                                                                                        |
| NC6  | PASS  | 原始 ns 序列：有 cwd 持有者时 `umount -n` exit 32（EBUSY），无持有者成功，`-l -n` 有持有者也成功且条目消失；生产会话结束后 ns 成员为 0、记录删除、租约空闲；下一会话（NC7）能重挂                                                                                                                                                                                                                             |
| NC7  | PASS  | 照实记录：pi 的 cwd 在挂载内时外部 TERM gocryptfs，2.5 s 内 gocryptfs **自己退出**；ns 内挂载条目消失，读 `data.txt` 得 ENOTCONN；pi 退出后正常收尾，状态干净（T2 关闭：只影响文案）                                                                                                                                                                                                                          |
| NC8  | PASS  | 孤儿 gocryptfs（setsid）在监督者死后仍持租约；按 ns id 杀成员后 ns 消失、租约释放，之后 `lock` 0（清理 stale 记录）                                                                                                                                                                                                                                                                                           |
| NC9  | KNOWN | 同 uid 经 `/proc/<pi>/root` 读到明文；`nsenter -t <P1> -U -m --preserve-credentials` 读到明文。已接受的残余                                                                                                                                                                                                                                                                                                   |
| NC10 | PASS  | 全量模式：真 pi（仓库 devDependency）在会话内 `--version` exit 0；`-p hi`（临时 HOME、无已装包、最小 env、无凭据、`PI_OFFLINE=1`）⇒ "No API key"，零模型请求；收尾干净                                                                                                                                                                                                                                        |
| NC11 | PASS  | 实测 gocryptfs 退出码 `{version:0, badflag:1, wrongPassword:12, noCipherdir:6, nonEmptyMnt:10, noMountpoint:10}`，都 <200；启动器的租约忙码为 213，不在其中（T3 关闭）                                                                                                                                                                                                                                        |
| NC12 | PASS  | 在生产链里的 pi（Node）内：继承的 fd 9 = 租约，flags `02100002`（Node 置了 CLOEXEC）；`stdio:"inherit"`、`detached`、嵌套 Node、bash 工具同款 `["ignore","pipe","pipe"]` 的子进程都拿不到 fd 9；显式槽 9 的子进程拿到 fd 9（flags `0100002`，无 CLOEXEC）；`src/bash/process.ts` 仍是该 stdio                                                                                                                 |

NC10 偏离方案原文：方案写的是 `pi --no-extensions -p`，但启动器本来就拒绝 `--no-extensions`（64，加密守护依赖扩展）。探针改用 `-p`，临时 HOME 里没装任何 pi 包，实际也是无扩展运行。

探针纪律：每一步都有超时（单步 ≤20–60 s，Node 程序 360 s 硬截止，外壳 `timeout -k 5 380`）。终止按归属授权：探针给自己派生的每个进程加随机 token `PI_TOOLKIT_TEST_RUN`；清理和测试侧的每个信号都要求同 uid、起始时间晚于探针、`/proc/<pid>/environ` 含 token、两次读到的 starttime 一致。只是 argv/cwd 提到临时目录的进程只报告（`INFO cleanup: … not signalled`），`SELFTEST cleanup-decoy` 行证明这样的进程能活过清理。之后 `fusermount3 -uz` 临时根下的残留挂载，最后删目录；外壳另有一层兜底：Node 被杀时也会卸载并删除。前提是运行期间没有外来的全局 `fuse.gocryptfs` 挂载（`run --private` 此时本来就拒绝）：conformance 测试持 gocryptfs 测试锁来保证；单独运行时，探针启动时检查一次（`SKIP all`），每个启动器会话前再查一次（显式 `SKIP <id> …`，不会误报为 FAIL）。退出码：0 = 无 FAIL（或 SKIP all），1 = 有 FAIL 或 SELFTEST 失败，64 = 用法错误。

## 4. 实测发现

1. **普通模式 gocryptfs 守护进程的 cmdline 也带 `-fg -notifypid=<父>`**：守护化就是带这两个参数重新 exec 自己，单看 cmdline 分不出私有还是普通模式，要看 `/proc/<pid>/ns/mnt`。harness 的清理按临时根路径找进程，不依赖这一点。
2. **gocryptfs 的 `logger` 子进程也继承 fd 9**：持租约的是「gocryptfs + 它的 syslog logger」。logger 会随 gocryptfs 退出（读端 EOF），不影响判活：ns 扫描会把它算作成员，ppid 链到 gocryptfs 锚点，可证明归属。测试与 NC2 断言的是「持有者 ⊆ gocryptfs 及其子进程」。
3. **普通 `lock` 的 cwd 占用扫描按路径比对，跨挂载命名空间会误报**：6a (c-b) 中，私有 ns 里的孤儿 job 的 cwd 路径字符串和全局挂载点相同（其实指向已死的私有挂载），普通 `lock` 把它当占用者，返回 76。方向是 fail closed，只损失可用性；`lock --lazy` 能卸掉。可在 L0 扫描里比对 `/proc/<pid>/ns/mnt`，但改的是 N0 冻结路径（golden），本包没动，留待评审决定。
4. **F1（已修正，r3.1）：`phase=session ∧ pi 存活` 的判定原先优先于 orphan / orphan-ns**。P0 是 pty 的控制进程，P0 一死，前台进程组（P1 + pi）就收到 SIGHUP，默认处置的 pi 会跟着退出（6a 中观察到）；只有不怕 SIGHUP 的 pi（nohup/tmux 类）能在 P0/P1/gocryptfs 都死后存活。修正前这种状态以及「只杀 P1、P0 与 pi 仍活」都一直判 session，`lock`/`lock --kill` 都 76，「带可证明成员的 orphan-ns」在真实条件下到不了。主会话裁定采纳修正（§5）：session 还要求 supervisor 存活，其余落入 orphan / orphan-ns，由 `lock` / `lock --kill` 走既有外部收尾，只终止可证明的成员。
5. **NC7（T2）**：有占用时外部 TERM gocryptfs，它照样退出（不因 EBUSY 留着），挂载变 ENOTCONN。§3.4 第 4 步「TERM → ≤2 s → KILL」的文案无需改。
6. ns 内触发的 `pi-secure` 读不到宿主同 uid 进程的 ns 链接（EACCES），所以从会话内部做的扫描不完整（N2 已知，NC3 的 setns 失败是同一事实）。

## 5. §实现修正（交安全评审）

两类改动：两个**测试缝**（评审已认可），以及一处 **F1 状态表修正**。

**测试缝**

- `testWorkerDelayMs(op)`：读 `PI_SECURE_TEST_WORKER_DELAY="<op>:<ms>"`（≤60 s），`__mount-work` worker 在执行该 op 前睡眠。仍处在 worker 自己的期限内，延时过长只会变成该 op 的超时（fail closed）。用于把 launching 窗口拉长（`post-mount:4000`）。
- `testFinalizeStallMs()`：读 `PI_SECURE_TEST_FINALIZE_STALL_MS`（≤60 s），P1 的 `finalizeInNs` 在**挂好 10.5 s 硬后备之后**睡眠。效果只能是「收尾更慢 → 硬后备 75 → P0 外部收尾」，即最坏路径；也用于拉长 finalizing 窗口（3000）。

两者与既有的 `PI_SECURE_TEST_SCAN_DELAY` 同类：环境变量驱动，只会让运行变慢或按自身预算失败，不放宽任何判定、证明或信号前复验。安全上的考量：同 uid 的环境本来就能改 PATH / 直接 kill，这两个变量不带来新能力。

**F1 修正（r3.1，主会话裁定，交安全评审）**：`judgePrivateInstance` 的 session 规则从 `phase=session ∧ pi 存活` 改为 `phase=session ∧ pi 存活 ∧ supervisor 存活`（1 行），`private-plan.md` §3.3 表同步并加「r3.1 修订（N4 F1，主会话裁定）」注。

- 效果：supervisor 已死时，gocryptfs 活 ⇒ `orphan`；gocryptfs 死且 ns 有成员 ⇒ `orphan-ns`（有可证明成员）或 `ns-in-use`（无）。`lockPrivateDecision` 对 orphan / orphan-ns 本来就给 `outer`，与 `--kill` 无关，所以 `lock` 与 `lock --kill` 都走 §3.5 既有外部收尾，即方案 orphan 行的既有约定。
- 终止权不变：`outerPrivateCleanup` 只信号经 `memberAuthorized` 证明的成员。pi 按记录的 pid+starttime 作为锚点，成员必须同时满足 mnt ns == 记录 ns、user ns ∈ {外层, 内层}、starttime ≥ supervisor.start；job 经 ppid 链连到活着的锚点。无证明者只报告（`ns-in-use`）。
- supervisor 活着时仍是 session：不带 `--kill` 的 `lock` 拒绝（76），不碰 pi。
- 不变的部分：挂载入口（`run --private` / `unlock`）在这些状态下仍 76；`lockPrivateDecision`、outer 收尾、释放协议都没改。
- 测试：单元矩阵新增 4 种组合；e2e 新增 3 个用例：
  - nohup 类 pi：P0/P1/gocryptfs 死 ⇒ `orphan-ns`，`lock --kill` 终止 pi 与 job，记录删除、租约释放；
  - 只杀 P1 ⇒ `orphan`，`lock --kill` 终止 pi 与 gocryptfs，P0 随后退出；
  - 反例：supervisor 活、P0 死、pi 忽略 SIGHUP ⇒ 仍 session，`lock` 76 且无任何终止，会话随后经自己的 supervisor 正常收尾。

## 6. 偏离（测试断言的是实际行为，不是方案旧措辞）

- **6a (b)** 方案写 `orphan-ns`，实测为 `private:ns-in-use`（r3.1 后不变）：pi 已因 SIGHUP 退出，孤儿 job 的 ppid 链断了，按 N1 评审 #2 无法证明归属，只报告。拒绝行为（`run --private`/`unlock` 76）与方案一致。
- **6a (d)** 方案写「`lock` 终止后台 job」，实测 `lock` 76 并把它列为「无法证明属于该实例，只报告、不终止」；由人工（测试）结束 job 后，`lock` 才经释放协议清理（0），新 `run --private` 成功。这是 N1 评审 #2 终止权收紧的直接后果。
- **6a (c-b)** 无记录 + 租约空闲时，普通 `unlock` 确实被允许（0，全局挂载）；随后普通 `lock` 因 §4-3 返回 76，改用 `lock --lazy` 卸载。
- **6a 前提**：方案要求「确认 P0、P1、shell 链均已不在」。shell 链 exec 后就是 P1，杀 P1 即杀链；P0 一死 pi 收到 SIGHUP（§4-4）。
- **§6.2-5「插件复检 LOCKED」**只断言插件的判据（会话 ns 的 mountinfo 中该挂载为 absent，`vaultMountState`）。插件自身的 LOCKED 逻辑由 N3 的 domain/guard 测试覆盖，本包没有在会话里加载真插件。
- **NC10** 用 `-p` 代替 `--no-extensions -p`（§3）。
- **NC2b** 用假 pi（自己处理 SIGINT），没用真 `pi -p`：无凭据的真 pi 会立即以 "No API key" 退出，无法在运行中按 ^C。

## 7. 耗时（本机）

| 文件                                          | 用例 | 墙钟                                       | 备注                                                                                        |
| --------------------------------------------- | ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `tests/secure/launcher-private.test.ts`       | 21   | 单跑 ≈ 77 s（首版 18 例）；并行负载下 86 s | 最慢：最坏路径 13.7 s、mount.lock 73 10.4 s（10 s 认领等待是产品常量）、`--lazy` 对照 7.1 s |
| `tests/secure/private-real-harness.test.ts`   | 3    | < 1 s                                      | 不挂载                                                                                      |
| `tests/conformance/secure-private-ns.test.ts` | 16   | ≈ 14 s                                     | 探针全量（含真 pi 两次）；与 secure-gocryptfs 同跑 ≈ 35 s（持同一把锁，串行）               |
| `scripts/dev/secure-ns-probe.sh --fast`       | —    | ≈ 9 s                                      | 全量 ≈ 13 s                                                                                 |

放置说明：vitest 的 `include` 是 `tests/**/*.test.ts`，`tests/conformance` **也在默认 `npm test` 里**（`test:conformance` 只是子集入口）。把慢用例挪进 conformance 不会减少 `npm test` 的时长，所以 e2e 保持在一个文件里。单个用例都 ≤14 s，整个文件持 gocryptfs 测试锁约 77 s（与其他真机套件串行）。若要真正移出默认套件，需要加环境门控（例如 `PI_SECURE_E2E=1`），这会改变「自门控」口径，留待决定。

## 8. 自验（评审 / 验收修复后）

| 命令                                                                                            | 结果                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npx vitest run tests/secure tests/config --maxWorkers=3`                                       | 55 文件 / 1118 用例全过，191 s                                                 |
| `npx vitest run tests/conformance/secure-*.test.ts`（连续 3 次）                                | 3/3：2 文件 / 22 用例全过，每次 ≈ 35 s                                         |
| `sh scripts/dev/secure-ns-probe.sh --fast`                                                      | exit 0，`SELFTEST cleanup-decoy PASS`，`SUMMARY pass=12 fail=0 known=1 skip=1` |
| `npm run typecheck`                                                                             | exit 0                                                                         |
| `sh -n src/secure/bin/pi-secure`、`sh -n scripts/dev/secure-ns-probe.sh`                        | 通过                                                                           |
| `npx prettier --check .`                                                                        | 全部通过                                                                       |
| `pi-secure status`                                                                              | 正常（真实 `demo` 旧布局库 locked，未触碰）                                    |
| 残留：`grep gocryptfs /proc/self/mountinfo`、`pgrep -u $USER gocryptfs`、临时目录、`sleep 1000` | 全部为空                                                                       |
| 防回归实测：撤掉 `runWorker` 预算接线                                                           | L「worker timeout」失败（16 s，退出码非 75）；恢复后通过                       |
| `grep -rn PI_TOOLKIT_TEST_RUN src/`                                                             | 0 行（产品代码不读测试 token）                                                 |

## 9. 残留

- **L0 跨挂载命名空间占用误报（§4-3）**：普通 `lock` 的 cwd 占用扫描按路径比对，私有 ns 里 cwd 路径相同的进程会被算作全局挂载的占用者，返回 76（fail closed，可用 `lock --lazy`）。按主会话裁定保持为残留，由 N5 在文档中披露。
- 最坏路径「P1 75 → P0 外部收尾」只能靠 stall 测试缝稳定复现；worker 超时另有独立用例（§2）。
- NC9 是已接受的残余（同 uid 不是边界），探针永远输出 KNOWN。
- 真 pi 的 ^C（NC2b）和插件在会话内的 LOCKED 复检，仍留给 acceptance.md J 节真机清单。
- 默认 `npm test` 包含 `tests/conformance` 与本 e2e 文件（§7）。

## §安全评审处置（gpt-6.1-sol，secure-N4-security-r1：0 Blocker / 3 Major / 1 Minor）

| #   | 严重度 | 问题                                                         | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Major  | harness 清理对历史 `ChildProcess.pid` 无条件发进程组 SIGKILL | 修复：script(1) 组登记为 `{pid, start}`，`exit` 事件即移除（回收后不再碰该 pid）；`killGroup` 发信号前复验 pid+starttime 且 pgid == pid，否则跳过；tty 的超时计时器走同一函数。harness 不再保存 ChildProcess 列表。回归：`private-real-harness.test.ts`「recycled identities」用 kill spy 证明错误 starttime 的组长、非组长、过期 tracked 都是零信号，真实组长恰好一次                                                                                                                                                                                                                                                                                                                     |
| 2   | Major  | 探针与 harness 以 cmdline/cwd 含临时目录作为终止授权         | 修复：强归属证明。每次运行生成随机 token，经 `PI_TOOLKIT_TEST_RUN` 传给本测试派生的所有进程；终止前要求同 uid ∧ starttime ≥ 运行开始 ∧ `/proc/<pid>/environ` 含 token ∧ 两次读到的 starttime 一致，否则只报告。路径匹配只做诊断。变量名特意不用 `PI_SECURE_` 前缀：`piChildEnv` 与 `hubSafeEnv` 只剥离 `PI_SECURE_*`，所以它原样经 P0 → P1 → gocryptfs（及其 logger）→ pi → pi 的子进程传下去（NC8 的「按 ns id 杀成员」改为 token 门控后仍能清空 ns，即实证）；产品代码不读它（`grep -rn PI_TOOLKIT_TEST_RUN src/` 为零），不进入任何判定。回归：harness 自测「unrelated process … never signalled」「token alone is not enough」；探针 `SELFTEST cleanup-decoy PASS`（conformance 断言） |
| 3   | Major  | F1 缺陷被固化成通过断言                                      | 主会话裁定采纳修正：状态表 r3.1（§5），实现 + 方案 + 单元矩阵 + 3 个 e2e（含「只杀 P1」场景与 supervisor 存活的反例）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | Minor  | 最坏路径不经过 worker 超时                                   | 补 L「worker timeout」（`readdir:15000` 超 3 s 预算 ⇒ 75），并实测撤掉 `runWorker` 预算接线会让它失败（§2）；报告把「worker 超时」与「收尾兜底」分开列                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

§4-3（L0 跨 ns 占用误报）按裁定保持为残留，由 N5 文档披露（§9）。

## §验收处置（kimi，secure-N4-verify）

| 严重度  | 问题                                                                                                            | 处置                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker | `secure-gocryptfs.test.ts` 经 `secure-probe.sh` 建全局挂载却不持测试锁，与 `secure-private-ns` 并跑时 NC10 失败 | 修复：C1–C3 块的 beforeAll 先 `acquireGocryptfsTestLock()`，afterAll 释放（beforeAll 超时放宽到 430 s，覆盖锁等待 + 探针）。现在所有建真实挂载的套件都持同一把锁。复验：`npx vitest run tests/conformance/secure-*.test.ts` 连续 3 次全过（§8） |
| Major   | 探针只在启动时查一次外来全局挂载                                                                                | 修复：注释与 §3 写明「依赖测试锁保证无并发全局挂载」的前提；每个启动器会话（A/B/C/D、NC2c、NC10）前再查一次，命中即输出 `SKIP <id> a foreign global fuse.gocryptfs mount appeared mid-run (<挂载点>) …`，不再误报 FAIL                          |
| Minor   | e2e 文件进默认 `npm test`                                                                                       | 已披露（§7），未改                                                                                                                                                                                                                              |
| Nit     | prettier 对显式传入的 `.sh` 报 No parser                                                                        | 不影响 `format:check`（扫目录时忽略未知扩展），未改                                                                                                                                                                                             |

## §安全复审第 2 轮处置（secure-N4-security-r2：清理安全与 worker 预算三项已闭合；F1 自动收尾链 2 Major）

主会话裁定后的修复如下。行号指当前工作区的 `src/secure/bin/helper.mjs`（`git diff src/secure/bin/helper.mjs` 里还包含 N4 首轮的测试缝和 F1 那一行，测试缝在 1266–1281、4337–4338、4840–4841 行，F1 的 session 规则在第 2991 行）。

### F1-1 [Major] supervisor 判活任意读取失败被当作已死 → 三态判活

| 位置（helper.mjs）                                            | 改动                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2324–2332 `REC`                                               | 新增 `REC.SUPERVISOR = 26`                                                                                                                                                                                                                                                                                                 |
| 2393–2426 `readProcStart` / `identityState` / `identityAlive` | `readProcStart` 不再吞错误，返回 `{live,start}` / `{gone}`（ENOENT/ESRCH 或僵尸）/ `{error,code}`。新增三态 `identityState`：dead 只在「确已消失」或「读到的 starttime 与记录不符」时成立，其余（EACCES/EIO/EMFILE/无法解析/EISDIR）为 unknown。`identityAlive` = `identityState === "alive"`。`readFile` 可注入（测试缝） |
| 3007–3037 `privateInstanceState`                              | supervisor 用 `identityState`。unknown 按 alive 进 judge（session，不进 orphan / orphan-ns）。同一次判活的 ns 扫描若看到记录的 P1（pid+starttime）存活，覆盖为 alive，不保留先前的否定读数。结果带 `supervisorState`                                                                                                       |
| 3232–3237 `lockPrivateDecision`                               | `supervisorState === "unknown"` ⇒ refuse 76「无法确认监督进程状态（pid N，/proc 读取失败）——未执行任何操作」，对普通 / `--kill` / `--lazy` 一律适用                                                                                                                                                                        |
| 3578–3585 `cmdPrivateTerminate`（`__private-terminate`）      | 线性化点（mount.lock 内）再证明一次 supervisor 已死：`identityState !== "dead"` ⇒ 不收尾，输出 `{supervisor:"alive"\|"unknown"}`，返回 `REC.SUPERVISOR`                                                                                                                                                                    |
| 3909–3916 `outerPrivateCleanup`                               | `REC.SUPERVISOR` ⇒「监督进程仍在运行 / 无法确认监督进程状态，未执行外部收尾（记录保留）」，退出 76                                                                                                                                                                                                                         |

测试：

- `launcher-private-unit.test.ts`「review N4-r2 #1」三例：
  - 三态真值表：ENOENT/ESRCH/僵尸/starttime 不符 ⇒ dead；EACCES/EIO/EMFILE/EPERM/EISDIR/无法解析 ⇒ unknown。
  - 注入 supervisor stat EIO、扫描也看不到 P1 ⇒ unknown ⇒ session；`lock` / `--kill` / `--lazy` 都 refuse 76，文案「无法确认监督进程状态」。gocryptfs 也死时仍判 session，不会变成 orphan-ns。
  - 注入 EIO 但扫描看到 P1 活 ⇒ alive ⇒ session，lock 按「会话仍在运行」拒绝。另含对照：ENOENT ⇒ dead ⇒ orphan ⇒ outer。
- `launcher-private.test.ts` 反例用例新增：对活着的 supervisor 直接调用 `__private-terminate` ⇒ `REC.SUPERVISOR`、`"supervisor":"alive"`、零信号。

### F1-2 [Major] 外部收尾的 `ns:false` 回填旁路 → 删除回填

| 位置（helper.mjs）                             | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3591–3606 `signalVerified`                     | 新增 `userNs` 选项：pid+starttime、mnt ns 之外，再要求 user ns ∈ 给定集合                                                                                                                                                                                                                                                                                                                                                                                              |
| 3619–3626 `terminateInstance`（无 ns 记录）    | 记录未登记 ns ⇒ 任何目标都过不了成员授权 ⇒ 零信号；活着的记录身份只报告（`ok:false`）                                                                                                                                                                                                                                                                                                                                                                                  |
| 3643–3657 `terminateInstance`（collect / sig） | 删除 pi / supervisor / gocryptfs 的 `ns:false` 回填。目标只来自 ns 扫描 + `memberAuthorized`（bootId ∧ mnt ns ∧ user ns ∈ {ns.user, ns.innerUser} ∧ starttime ≥ supervisor.start ∧ 锚点链）。没进集合但仍活着的记录身份列入 `unverified`（「记录身份未通过命名空间/成员校验」），只报告。每个信号前 `signalVerified(m, s, { nsMnt, userNs })` 复验同一套条件。`ok` 为 false 时，`outerPrivateCleanup` 已有路径保留记录、退出非零并逐条列出「未经证明的进程……人工核对」 |

`private-plan.md`：第 327 行（session 行）不变；第 335 行之后新增「r3.1 补充（N4 安全复审第 2 轮，主会话裁定）」（第 337 行）；第 339 行「终止权（I-P4′）」改写为「r3.1 收紧」：记录身份只能做锚点，不能绕过 ns 校验单独成为目标；外部收尾的前提包含「supervisor 已被证明死亡」；信号前复验 mnt ns 与 user ns。

测试（`launcher-private-unit.test.ts`「review N4-r2 #2」三例，经真实的 `terminateInstance` 而不只是纯函数）：

- `signalVerified` 的 user ns 拒绝。
- 反例：记录的 pi pid+start 完全匹配但在 `mnt:[9]`，记录的 supervisor 在正确 mnt ns 但 user ns 外来；同时有一个合法锚点（gocryptfs + logger）。结果：pi / supervisor 零信号，gocryptfs 照常处理，`ok:false`，unverified 含两者。
- 无 ns 记录 ⇒ 零信号、身份被报告。

既有 e2e（真实 P1/pi/gocryptfs 都在记录 ns 里）不受影响：F1 三例仍全部通过，pi 与 job 照常经成员授权被终止。

### 自验（第 2 轮修复后）

| 命令                                                                        | 结果                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npx vitest run tests/secure tests/config --maxWorkers=3`                   | 55 文件 / 1125 用例全过，192 s                                                 |
| `npx vitest run tests/conformance/secure-*.test.ts`（单独，连续 2 次）      | 2/2：2 文件 / 22 用例全过，≈ 35 s                                              |
| `sh scripts/dev/secure-ns-probe.sh --fast`                                  | exit 0，`SELFTEST cleanup-decoy PASS`，`SUMMARY pass=12 fail=0 known=1 skip=1` |
| `npm run typecheck`                                                         | exit 0                                                                         |
| `sh -n src/secure/bin/pi-secure`                                            | 通过                                                                           |
| `npx prettier --check .`                                                    | 全部通过                                                                       |
| `pi-secure status`                                                          | 正常（`demo` 旧布局库 locked，未触碰）                                         |
| `grep gocryptfs /proc/self/mountinfo`、`pgrep -u $USER gocryptfs`、临时目录 | 全部为空                                                                       |
