# schedule macOS（Darwin）支持 — 实施报告（P0-P5）

> 依据：`darwin-arch.md`（架构，含 §9 已拍板残余）与 `darwin-plan.md`（方案，含 §8 验收矩阵 / §8.2 残余核对表）。
> 本报告记录 P0-P4C 的交付、实测证据、偏差与已知残留；事实源回写见 `README.md`「macOS（Darwin）支持」小节。
> 证据类别口径（darwin-plan §5.4）：**E-MAC** = mac 真机运行；**E-CI** = Linux CI；**E-AUX** = Linux 上强制 darwin 后端的算法辅助证据，不得替代 E-MAC。

## 1. 版本与执行环境（全部 E-MAC 在此环境取得）

- macOS 27（darwin arm64），本机**无 `flock(1)`**（保持缺失——锁必须走 perl 后端，不能被系统 flock 掩盖）。
- Node v26.13.1。
- perl 5.34.1（`/usr/bin/perl`），`Fcntl`/`Errno` 导出可用（`-MFcntl=:flock`、`-MErrno=EWOULDBLOCK,EAGAIN`，plan 评审 #8 口径）。

## 2. 包交付记录（分支 feat/schedule-darwin，P0-P4C 全部合入）

| 包   | commit    | 内容                                                                                |
| ---- | --------- | ----------------------------------------------------------------------------------- |
| P0   | `bed3d71` | platform seams（`PathBackend`/`LockAcquire`/`IdentityDeps` 最小签名）+ 冻结差分基线 |
| P1   | `9b3bc4a` | Darwin identity probe（ps/sysctl，epoch-ms）+ start 域判定 + wire 注入              |
| P2   | `555280b` | Darwin 快照路径后端（pre/fstat/post 比对、fd 注册表、birthtime 兜底）               |
| P3   | `36ce256` | perl `flock(2)` 锁后端（`perlFlockAcquire` + 平台感知 probe）                       |
| P4-A | `ce1c150` | hub schedule service 平台 identity/paths 注入（只读侧）                             |
| P4-B | `8ee4fd1` | 平台感知测试套件 + darwin e2e（integration，非 darwin skipped）                     |
| P4-C | `4fd0d17` | e2e 补真实 hub 段（投影 / receipt / 未知预测 / 零写入）                             |

主会话修正（合入后的 verifier/集成修补）：`ecf0d0f`（P2 资产 verifier 追尾）、`e39d598`（JUDGE_MANIFEST service 坐标与 probe 接线注释修正）、`cf8633d`（P3 锁套件 mac tmpdir realpath + repair holder 预创建 `.lock`）、`77fac4e`（off-golden harness 平台无关 tmp 归一化）、`8c5ca45`（reader M3 vault-vs-moved 登记为有意差异 #2）。

## 3. 验收证据摘要（E-MAC，mac 真机）

- **mac schedule 基线：587 红 → 0**（darwin-plan §5.1 基线命令，P4-B 前后对比；P4-B 落地时 13 个剩余红全部在 P3/P4-A 文件域与既有 off-golden mac tmpdir 泄漏，经 P3/P4-A 合入与主会话修正后清零）。
- **e2e 5/5**：`tests/integration/schedule-darwin-e2e.test.ts` 五段全绿——create（cron/once/every）→ run_now（两种 executor）→ 真实时钟 auto-claim → list/history → **真实 hub 段**（投影含该 session 任务、receipt 清理 pendingReports、未知运行预测、hub 对账本零写入）+ secure/locked 无表面门。
- **paths D4 压力竞态**（`tests/integration/schedule-darwin-paths-race.test.ts`）：N=2000 轮替换（真实目录 ↔ 指向外部符号链接），`outsideEntries=0`（外部目录零触碰）——好于判据下限（判据仅要求结果 ∈ {成功, moved/symlink/missing/io, E_DEGRADED}、无挂起泄漏、`size` 回基线，触碰计数如实记录不作失败；0 是实测值，不是承诺）。
- **perl 锁**：互斥实测（并发恰一个 `held`、其余 busy=75）；SIGKILL 实测（持锁进程 `kill -9` 后锁随 open file description 立即释放，无 stale 回收、无强拆）；`repair()` 对活持锁 ⇒ E_BUSY。缺 perl 路径以注入 spawn 断言文案 fail closed（E_BUSY + warning）。
- **identity 真机**：`createDarwinIdentity().readSelf()` 实测 `start ≈ 1.79e12`（UTC epoch ms，`% 1000 === 0`），`boot` 为 bootsessionuuid，与 `ps -o lstart= -p <pid>`（固定 `LC_ALL=C TZ=UTC0`）和 `sysctl -n kern.bootsessionuuid` 人工比对一致。
- **Linux 不变（E-CI，待办）**：见 §6。

## 4. 偏差登记表（与 darwin-plan 文字的逐项差异）

| #   | 偏差                                                                                                                                                                        | 处置 / 口径归属                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | reader M3「祖先 rename 进 vault + 原位同名符号链接」场景：Linux 经 fd 真实位置判 `vault`，Darwin 无内核 fd 位置视图，诚实报 `moved`（fail closed，不声称能区分 vault-move） | 已登记为**有意差异 #2**（plan P2-a 认可口径；`8c5ca45`），`reader.test.ts` 按平台分支断言，**Linux 断言未放宽**                                                                                                                                                      |
| 2   | `note.test.ts` 未在 plan §5.2 #6 的逐链清单中点名，但属 `judgeHolder` 消费链，需要 probe 到达证据                                                                           | **追列入 §5.2 #6 口径**：与 digest/clock/service 同等对待，注入 `platformProbe()`（`8ee4fd1`），`JUDGE_MANIFEST` 扫描与 `identity-domain.test.ts` 按文件计数覆盖 note×2                                                                                              |
| 3   | e2e auto-claim 段：plan 文字用 FakeClock 推进触发，实现改用**真实 timer**（`once` 任务约 1.2 s 后到期）                                                                     | `activate()` 把生产 `systemClock` pin 死在 wiring 里，FakeClock 无法在不绕过被测接线的情况下推进；真实 timer 使证据类别为**更强的 E-MAC**（真实时钟、真实 perl 锁、真实 ps/sysctl 身份全程参与），代价 ~37-61 s 真实墙钟时间，tier2 可接受                           |
| 4   | `sched-platform.ts` 的 darwin lock holder 用 perl `open(F, "+>>", …)`，plan 文字为 `+<`                                                                                     | 纯文字差：`+>>` 匹配 `flock(1)` 的「不存在则创建」语义（`sleep` holder 场景等价）；**当前全部调用点均已预创建锁文件**，两种模式行为一致；注释已写明该等价性与前提（`spawnLockHolder`）                                                                               |
| 5   | `fixtureSelf()` 在非 Linux 返回**静态 boot**（`"sched-fixture-boot"`）与静态 `FIXTURE_START_MS`                                                                             | 测试编写陷阱提示（非缺陷）：tier1 免 spawn 的 fixture 身份只能判「与自己同身」；**新增测试若拿它去判真实异进程 holder，会因 boot 不同被误判 `dead(crash)`**——判真实异进程请用 `platformIdentity()`（真 probe、proc 登记），fixtureSelf 只用于免子进程的自holder 场景 |
| 6   | `JUDGE_MANIFEST` 条目带行号（如 `service.ts:392`），`e39d598` 修正过一次 service 坐标                                                                                       | 行号是**信息性坐标**，消费方按「文件前缀计数」比对（`identity-domain.test.ts` 断言 `{note×2, digest×1, wire clock-judge×1, service×2}`），行号漂移不改变契约语义；行号仍保留以便人工定位                                                                             |

## 5. 已知环境性残留（非本特性引入，另行立项）

- **bundle-parity 在 mac Node 26 的 64 KB stdout 管道截断**：`tests/governance/bundle-parity.test.ts`（tier2，真实 tsx）在 mac 上因 Node 26 的子进程 stdout 管道缓冲行为截断而红；与 schedule darwin 无关（复现于基线期）。
- **`test:tier1` 在 mac 的 176 个非 schedule 既有红**：web-hub / memory / secure 等套件在 mac 的既有失败（与 P0 前基线抽样比对一致，非本期引入）；schedule 相关失败已全部清零（§3）。Linux CI 上该套件全绿。

## 6. E-CI 待办

- **Linux 零回归由 CI 提供**：分支 push 后核对 `format:check → typecheck → test:tier1 → test:tier2 → build` 全绿（darwin 真实进程项显示 **skipped**，不计入 Linux 证据也不得误记为 Darwin 验证）。
- **Linux 上实跑的 darwin 相关项（E-AUX）**：`paths-backend`（Linux 上强制 `darwinPathBackend` 的算法辅助证据）与 perl 锁测试（perl 可用时）在 Linux CI 实跑；只证明算法在 Linux fs 语义下自洽，**不得**替代 mac 真机结论。
- A 级冻结件核对：`git diff --quiet origin/dev -- tests/fixtures/`（每包已核，P5 再核一次）。

## 7. 结论

mac 真机（E-MAC）证据齐备：Darwin 可用（agent 全链路 + hub 只读投影）、边界与残余披露完整（README「macOS（Darwin）支持」小节 + 本报告 §4/§5）、Linux 不变由 CI 收尾。残余中 TOCTOU U1-U6、`ps` 秒精度、fsync 语义、birthtime 退化、perl 弃用风险均为**已接受**项（darwin-arch §9），不阻塞验收。
