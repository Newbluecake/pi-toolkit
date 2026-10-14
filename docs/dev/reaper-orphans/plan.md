# #27 修复方案：bash job 终止时整组升级 SIGKILL

> 状态：方案 r2（r1 经 glm-5.3 评审有条件通过，§7 吸收全部 9 条）。车道 L2（进程终止 = 不可逆操作，一票升级）。

## 1. 根因（摘自 root-cause.md，已证实部分）

`src/bash/process.ts` `killJobTree`：`kill(-pgid, SIGTERM)` 之后**只探测组长 pid** 是否存活，组长一死就返回
`"terminated"`，**永不发组 SIGKILL**。`npm test` 链（bash→npm→sh→vitest 主进程）都没有 SIGTERM handler，
组长 ~50ms 内就死了；而同组的 vitest fork worker 如果没被 SIGTERM 杀死（测试代码装了 listener，或者 swap 抖动卡在 D 状态），
就再也没有任何东西去杀它们 ⇒ PPID=1 的孤儿。子 run 超时的 seal 链（`sealSession → childBashRegistry.sealAndKill →
killAllNonTerminal → manager.kill → killJobTree`）以及 manager 的「job 已退出但还有管道持有者」分支
（`manager.ts:~1597`）都走这条路径，受影响。pi 内置 bash 是直接整组 SIGKILL，不受影响。

## 2. 修复（最小）

`killJobTree` 的存活判据从「组长 pid 存活」改为「**进程组非空**」，用 `kill(-pgid, 0)` 探测
（ESRCH ⇒ 组里没有成员；EPERM ⇒ 视为非空）。POSIX 通用，不扫 `/proc`。

```
SIGTERM 整组（不变；ESRCH ⇒ "already-dead"）
while now < deadline: sleep(poll); if !groupAlive(pgid) return "terminated"
if !groupAlive(pgid) return "terminated"
SIGKILL 整组 ⇒ "killed"
```

- **pid 复用安全性**：Linux 内核只要还有任何进程以某个 pgid 为进程组，就不会把这个数值再分配成新 pid（struct pid
  被组成员引用着）。所以「组非空 ⇒ `kill(-pgid)` 只会打到我们自己的组成员」成立。组空时 `kill(-pgid, SIGKILL)` 是 ESRCH，
  无害。残余窗口只有一种：组在 grace 期内清空，同时 pid 空间回绕，新进程恰好拿到同一 pid 并自立为组长——2s 内需要约 4M 次
  fork，可以忽略。这比现状（组长死后完全不管）更符合 §3.3「宁可泄漏不误杀」的精神：我们只对**确认仍有成员**的组升级。
- 前置守卫不变：`expectedProcStartTime` 不匹配 ⇒ refused；组长仍活但 pgrp≠pid ⇒ refused。
- 非 POSIX（win32）：`signalGroup` 本就退化为单 pid，`groupAlive` 同样退化成 `probePid(pid)`，行为不变。
- outcome 语义：原先误报 `terminated` 的场景（组长死、成员残留）现在会报 `killed`。调用方只用 outcome 生成文案与分类，
  不依赖它做状态转移（需要实现时核实 manager/child 中所有 outcome 消费点）。
- 时延：组长先死、成员也随 SIGTERM 退出时，返回时机与现状相同（下一次 poll 就会发现组空）。只有成员抗 SIGTERM 时才会多等满
  grace（默认 2s）后 SIGKILL。这正是期望行为；`sealAndKill` 是 fire-and-forget，registry backstop（grace+3s）只影响分类上报。

## 3. 兜底层（不做，理由）

root-cause §4 列出的 `child.ts` killAllNonTerminal 组空复核、`child-registry.ts` backstop 补杀：主修复之后这两层
是冗余的，而且要多碰两个文件和它们的测试面。不做；如果用户要求再加。

## 4. 测试

Linux-gated（`describe.skipIf(process.platform !== "linux")`），所有用例 `finally` 按记录的 pid/pgid 自行
`kill(-pgid, SIGKILL)` + 逐个 pid SIGKILL 清理，绝不依赖被测逻辑清理。

fixture（内联生成到 tmpdir）：`leader.mjs` 不装信号 handler，fork 一个 `worker.mjs`，再把两个 pid 写文件后保活；
`worker.mjs` 执行 `process.on("SIGTERM", () => {})`（显式忽略 SIGTERM），然后保活。

1. **ProcessPort 层**（`tests/bash/process-kill-tree.test.ts`，若已有同类文件则追加）：
   - `spawnJob("exec node leader.mjs")` → 等待 pid 文件 → `killJobTree(pid, { graceMs: 300 })` ⇒ outcome `"killed"`，
     ≤2s 内 `kill(-pgid, 0)` 为 ESRCH，worker pid 消失。
   - 回归：组长和成员都会被 SIGTERM 杀死（普通 `sleep` 子进程）⇒ `"terminated"`，且不会等满 grace（耗时 < grace）。
   - 组长已死、成员残留（先单独 SIGKILL leader，再调 killJobTree）⇒ `"killed"`，成员消失（对应 manager 的「管道持有者」分支）。
   - 守卫不变：starttime 不匹配 ⇒ `"refused"`，且没有发出任何信号（worker 仍存活，随后由 finally 清理）。
2. **Manager 层**（`tests/bash/` 现有 manager kill 测试旁追加一例）：`manager.create()` 跑 fixture → `manager.kill(jobId, { graceMs: 300 })`
   ⇒ 记录进入终态，进程组为空。
3. **E2E（集成，慢测 ≤10s）**（`tests/integration/bash-orphan-on-timeout.test.ts`）：真实 child bash registry +
   `sealAndKill(sessionId, 300ms)`，跑 fixture 的 job ⇒ 在 grace+slack 内组为空。如果真实 stack + fake model 搭建成本过高，
   允许下沉到 `child-registry`/`child.ts` 层的直连等价物，并在汇报里说明。

## 5. 文件域

`src/bash/process.ts`（主修复）；如有 outcome 消费点需要改文案：`src/bash/manager.ts`（只改文案/分类，不改状态机）；
测试：`tests/bash/**` 新增/追加、`tests/integration/bash-orphan-on-timeout.test.ts`（新）；`docs/dev/bash-timeout-grace/plan.md`
或 `docs/dev/bash-auto-background/*` 中描述 kill 阶梯的段落追加一句（实现时定位）。

## 6. 不改 / 记录

- pi 本体 `killProcessTree` 的 ESRCH 单 pid 回退：上游问题，override 开启时不走该路径。
- 「worker 为什么不理 SIGTERM」（测试代码装 listener 还是 D 状态）：不影响修复。并入 #21 测试治理，可以考虑加一个
  「worker 内无多余 SIGTERM listener」的守卫。
- dev-flow 反模式（多个并行 agent 各自跑全量 npm test）：调度纪律已写进派单模板。

## 7. 修订 r2（评审 r_EZ6SXAEA 全部吸收；r2 与前文冲突时以本节为准）

1. **测试断言不用 `kill(-pgid,0)` 判空**：僵尸仍算组成员，被 reparent 给 PID 1 后若不及时回收会 flake。改为扫 `/proc/*/stat`，统计 pgrp==pgid 且 state≠Z 的进程数为 0；窗口放宽到 5s。
2. **pid 复用窗口论证补全**：pid_max 可能是 32768（容器 / 嵌套 namespace 默认值），回绕所需 fork 数随之降为约 3.2 万次；即便如此，回收到的 pid 还必须 setpgid 自立为组长才可能被误打，窗口依旧极窄。
3. **只在 Linux 有 pgid 钉住保证**：XNU 没有同等保证，pid 空间也更小。非 Linux 上新语义的暴露面与现状相同（现状同样会在组长 pid 被回收时打到 -pid），不构成回归。文档不写「POSIX 通用」。
4. **recover() 时延**：`manager.ts` recover §3.9 对 owner:"subagent" 是串行逐个 await kill。新语义下，每个抗 TERM 的残组最多多耗一个 grace。⇒ recover 路径显式传 `graceMs: 500`，循环保持串行（预算 10s 内可处理约 16 个残组，超出部分下轮收敛）。seal、kill 工具路径维持默认 2s。
5. **outcome 消费点已核实**（无状态转移依赖）：child.ts:163-167 只分桶（terminated/killed 在同一桶）；manager.ts:717、:1597-1613、:1697 只判 refused 或用于生成文案；bash-job-tool.ts:707 是纯文本；recover 用的是 record.status；fake-port 测试自定 outcome；真实进程测试 process.test.ts:219/242/262 本就接受 terminated/killed 二选一。
6. **文件域补文档**：`src/bash/process.ts:65-73` 的 KillOutcome 注释按新语义改写；`docs/dev/bash-auto-background` 中 §3.2/§11「宁可漏杀」教义段补一句 pgid 钉住论证，说明组非空时补刀不违反 §3.3。
7. **回归用例不断言耗时 < grace**，只断言 outcome，或断言耗时 ≤ grace+slack。
8. **EPERM 写注释**：EPERM 视为组非空，随后的 SIGKILL 同样会因 EPERM 发不进去，outcome 仍报 killed。本仓库同 uid spawn，这种情况不可达。
9. **Manager 层补测**：直接覆盖 `manager.ts:1597`「job 已退出 + 管道持有者残留」分支，fixture 让组长退出、抗 TERM 的孙进程留下。
