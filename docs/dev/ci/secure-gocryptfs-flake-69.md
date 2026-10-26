# #69 secure 真 gocryptfs 用例负载偶发失败 — 根因与修复报告

日期：2026-10-27 · 范围：`tests/secure/launcher-convert`（§7.2-3 fail-seam / M2）、`tests/secure/launcher-private-cmd`
环境：本机全量/单文件 vitest（4 worker）+ `tests/web-hub/ui --maxWorkers=6` 循环背景负载（load avg 8–18）。

## 复现证据（负载下循环跑）

| #   | 用例                                        | 失败形态                                                                                                                                               | 复现处                                                             |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| F1  | launcher-convert §7.2-3 `13:after`          | 回滚走到「已卸载新库」后报 `回滚不完整：新库租约未空闲（held）`，断言 `已回滚` 失败                                                                    | `tests/secure --maxWorkers=4` iter1（/tmp/flake69/repro-full.log） |
| F2  | launcher-convert M2 `13:after`              | 同上族：回滚不完整 ⇒ `pending: convert:<txid>` 登记残留，`expect(vaultsOf(f.h).proj).toBeUndefined()` 失败（iter1 耗时 236.7 s 近超时；iter7 仅 15 s） | seam/M2 循环 M2 iter1、iter7（repro-seam.log）                     |
| F3  | launcher-private-cmd `lock --kill`（real）  | 831 ms 内返回 76：`无法确认保险库 acme 的 --private 实例状态（scan-incomplete）——拒绝操作`                                                             | pcmd 循环 iter5（repro-pcmd.log）                                  |
| F4  | launcher-private-cmd real block `beforeAll` | `Hook timed out in 250000ms` —— 跨文件 gocryptfs 锁排队超 250 s                                                                                        | pcmd 循环 iter9                                                    |
| F5  | launcher-private-cmd fake `--kill`          | 75：`10 s 内未完成收尾，执行外部收尾` + `命名空间仍有成员（pid … node/gocryptfs/logger）… 未经证明的进程`                                              | pcmd 循环 iter15                                                   |

另观察到 1 次 `launcher-private-unit` N1#5 失败（recFile 在 75 后仍存在），与 F5 同族，**不在本任务范围内**，见「遗留」。

## 根因

### R1（F1/F2）：convert 回滚的租约释放等待预算过小 —— 产品代码

`src/secure/bin/convert.mjs` `rollbackVault` 卸载新库后调 `waitLeaseReleased`（`LEASE_RELEASE_WAIT = {budgetMs: 3000, stepMs: 100}`），等 gocryptfs daemon 退出后释放 mount.lease 上的 flock。该重试是 commit 0f74709d 加的，3 s 预算在 4-worker 负载下被两次击穿。

实测（/tmp/flake69/lease-lag{,2}.sh，含 46 文件 234 KB 拷贝，load≈11–13）：正常挂载→卸载后租约 **5–31 ms** 即释放；失败时 3 s 窗口内一直 held。失败时刻的确切 holder 未捕获（见「遗留」），但无论 holder 是退出迟滞的 daemon 还是极端调度离群，3 s 相对正常值（≤31 ms）只有约 100× 余量，负载离群可以超过。**修复**：预算 3000→15000 ms（轮询仍是 /proc/locks 状态驱动、有硬上界；依旧 held ⇒ 保留新库并报告不完整，fail-closed 语义与检测力不变）。默认值无任何测试钉死（`convert-state.test.ts:511` 等都用显式小预算覆盖）。

### R2（F3）：`lock --kill` 的实例判定对瞬时非 dumpable 进程 fail-closed —— 产品行为正确，测试假设环境安静

`helper.mjs scanNsMembers`：同 uid 但 /proc/<pid>/ns/mnt 不可读（EACCES，非 dumpable——如 setuid-root 的 fusermount3、或任何 PR_SET_DUMPABLE=0 进程）且 starttime ≥ supervisor.start 的进程 ⇒ 扫描 `incomplete` ⇒ `judgePrivateInstance` 返回 `unknown/scan-incomplete` ⇒ 拒绝 76。这是**设计上的 fail-closed**（无法证明成员身份就不动手）。

最小确定性复现（/tmp/flake69/scan-repro2.mjs）：prctl(PR_SET_DUMPABLE,0) 的同 uid 子进程 + `minStart=基线` ⇒ `{"kind":"incomplete","reason":"ns <pid> python3 EACCES"}`；老进程（sd-pam/sshd）被 minStart 正确跳过。负载下并发套件不断 spawn 瞬时的 setuid `fusermount3`（已验证 `-rwsr-xr-x root root`），扫描窗口撞上即 76。**被拒绝的尝试不发任何信号**，幂等。

**修复（测试侧）**：`lock --kill` 用例对 `code===76 && text 含 "scan-incomplete"` 做有上界重试（≤10 次、间隔 300 ms），最终仍断言 0；`<12 s` 的耗时断言只作用于成功那次。不降低检测力：kill 路径、143、记录删除、租约释放等断言原样。

### R3（F4）：real block 整体持锁的 beforeAll 预算 240 s/250 s 太小 —— 测试侧

`acquireGocryptfsTestLock()` 默认 240 s、hook 250 s。全套件并行时锁可排在另一个文件的长 real block 后面数分钟（观测到 launcher-convert 单个 M2 用例持锁 236 s）。**修复**：`acquireGocryptfsTestLock(590_000)` + hookTimeout `600_000`，对齐 launcher-convert / init-cleanup-real 的既有先例。等待本身是锁事件驱动，只是上限按真实排队时间给足。

### R4（F5）：fake 实例的 mnt ns id 被内核复用 —— 产品 fail-closed 正确，测试场景有竞态

fake-instance 用例的 supervisor 是 `flock lease unshare … sleep 60` 里的一条 `sleep`。`lock --kill` TERM 后 sleep 立即死，其 mount ns 被释放；负载下并发的真实私有会话（别的文件）立刻复用**同一个 ns id**（内核 ns 对象 slab 复用），再判定时扫到一批无法证明归属的成员（记录的 supervisor 已死，ppid 链无处可证）⇒ 按 N1#2 设计 fail-closed：保留记录、报告、不杀 ⇒ 75。TERM 本身确实命中了正确的 pid（身份已校验）。

**修复（测试侧）**：识别这一特定 fail-closed 结局（`code===75 && text 含 "未经证明的进程"`），换新 fake 实例有上界重试（≤4 次）；用例 timeout 30 s→90 s（单次 75 路径本身要走完 10 s 收尾等待）。其余断言（监督进程 pid 消失、记录删除、租约空闲）不变。

## 改动

- `src/secure/bin/convert.mjs`：`LEASE_RELEASE_WAIT.budgetMs` 3000→15_000（+注释）。唯一产品改动。
- `tests/secure/launcher-private-cmd.test.ts`：R2 重试（lock --kill real）、R3 beforeAll 590 s/600 s、R4 重试 + timeout 90 s（fake --kill）。
- 诊断临时改动已全部还原（`helper.mjs` 的 FLAKE69-DEBUG 输出已撤，git diff 无 helper.mjs）。

## 自验

- `npm run typecheck` ✅ · `npx prettier --check` 改动文件 ✅ · `git diff --quiet HEAD -- tests/fixtures/` ✅（secure-off-golden / secure-contract-parity / secure-launcher-off-golden 字节不变）
- `npx vitest run tests/secure/launcher-private-cmd.test.ts --maxWorkers=1`（背景负载下）修复后 iter1 ✅ 42/42；iter2–6 见 /tmp/flake69/verify-pcmd.log
- `npx vitest run tests/secure --maxWorkers=2`（背景负载下）见 /tmp/flake69/verify-secure.log
- launcher-convert 全文件含 §7.2-3/M2 在 verify-secure 内覆盖；修复前基线：同环境 6 次相关失败（F1×1、F2×2、F3×1、F4×1、F5×1）

## 遗留 / open items

1. **F1 的确切租约 holder 未捕获**：/proc/locks 观察器在后台两次 stall（前台正常），修好后来不及再复现。15 s 的选择依据是「正常 ≤31 ms vs 失败 >3 s」的实测差距，而非 holder 画像；若日后再现，用 /tmp/flake69/lease-watch.mjs（前台跑）抓 STUCK? 行的 holders 字段。
2. **launcher-private-unit.test.ts N1#5**（`session publish blocked` 用例）在同环境失败 1 次：75 后 recFile 仍存在，与 R4 同族（外部收尾遇无法证明的 ns 成员）。不在本任务范围，建议按同一模式（识别该 fail-closed 结局 + 有上界重试）另行加固。
3. pcmd real block 的 `untilPhase`（30 s）、`b.ms < 15 s`（SIGSTOP 状态查询）在本次复现中未失败，未动。

## 建议 commit message

```
fix(secure): raise convert rollback lease wait to 15s, harden private-cmd tests under load

- convert rollback: LEASE_RELEASE_WAIT budget 3s -> 15s (state-driven poll of
  /proc/locks, same hard cap semantics; 3s was exceeded under 4-worker load,
  normal release measured <=31ms)
- launcher-private-cmd: retry lock --kill on the fail-closed 76
  scan-incomplete (transient same-uid non-dumpable processes, e.g. setuid
  fusermount3, make the /proc scan incomplete by design; refused attempts
  signal nothing, bounded retry is safe)
- launcher-private-cmd: real-block beforeAll lock acquisition 240s/250s ->
  590s/600s (cross-file gocryptfs lock queue can exceed 250s in a parallel
  full-suite run; matches launcher-convert/init-cleanup-real precedent)
- launcher-private-cmd fake --kill: bounded retry with a fresh fake instance
  on the 75 ns-members-unproven outcome (kernel recycles the dead fake
  supervisor's mnt ns id to a concurrent real session; the fail-closed
  retention is the designed ns-recycling safeguard)
```
