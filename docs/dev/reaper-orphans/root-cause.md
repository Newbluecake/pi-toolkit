# #27 孤儿进程根因调查（cr-glm/glm-5.3，r_16AMR7VZ）

实验已全部停止，`/tmp/orphan-test` 已删除，`ps` 确认无任何 vitest/npm/orphan 残留（现存 node 进程均为长期服务：DevEye、codex，与本调查无关）。以下为最终报告。

---

# 孤儿 vitest worker 根因调查报告

## 1. 现象复述

2026-10-14：一个 subagent run 在 bash 工具里前台跑 `npm test`（vitest 2.1.9 全量、默认 forks 池多 worker），run 被 total budget 超时终止后，8 个 `node (vitest N)` worker 进程成为孤儿（PPID=1、cwd=仓库、pgid 仍为原组），各 2.4–2.9GB RSS，存活 5–7 分钟，SIGTERM 无效，需 SIGKILL。

## 2. 调用链图

```
主会话 (pi TUI/RPC)
 └─ Agent 工具 → SpawnService → runtime-adapter → Runner.run()
     └─ PiSessionDriver.create() → createAgentSession()   ← 子会话与本扩展同进程（非 fork）
         │  activate(): isChildSession=true → index.ts:194 wireChildBashJobs（pre-guard）
         │  → 注册 bash override（src/tools/bash-tool.ts）+ bash_job
         │  （bashJobsEnabled: settings bashJobs.autoBackgroundS=290>0 且 Linux；
         │    childSessions 默认 true —— ~/.pi/agent/pi-subagent.json 仅覆盖 autoBackgroundS=290）
         │
         └─ 子 agent 发起 bash 工具调用 "npm test"
             └─ override execute → createBashToolDefinition(注入 operations.exec=execViaManager)
                 └─ manager.reserve() → spawnJob()  [src/bash/process.ts:305-320]
                     spawn(shell, ["-c", "npm test"], { detached:true, stdio:[ignore,pipe,pipe] })
                     ⇒ bash 成为新进程组组长（pgid === job pid）
                     进程链（同一 pgid，实验已证实）：
                       bash(组长) ─[exec]→ npm(node) → sh -c "vitest run" ─[exec]→ node vitest 主进程
                                                                    └─ fork × N  tinypool worker（同 pgid）
                                                                    └─ esbuild service 子进程
             └─ R 定时器 = min(now+290s, D−3s)（bash-tool.ts:377-415，D=hostView.watchdogDueAt）
                 ⇒ ~290s 时工具调用提前返回，job 转入后台（BashJobManager, owner:"subagent"）
                 ⇒ 此后 pi 的 AbortSignal 与该进程再无关联（stopForwarding）

[run total 超时]
Runner.fireDeadline (runner.ts:693) → reducer 判 kill → cancel
 → run() finally (runner.ts:1148+) → sealBeforeTerminal (runner.ts:645)
     → stack.ts:1981 sealSession → childBashRegistry.sealAndKill(sessionId, 2000ms, runId)
         → child.ts:133 killAllNonTerminal → manager.kill(jobId,{graceMs:2000})
             → process.ts:443 killJobTree:
                 ① 身份守卫（starttime + pgrp===pid，否则 refused→orphaned）
                 ② kill(-pid, SIGTERM)  ← 整组
                 ③ 每 50ms 轮询 probePid(组长) 至多 2s
                 ④ 组长已死 ⇒ return "terminated"（★ 不再发 SIGKILL ★）
                 ⑤ 组长还活着 ⇒ kill(-pid, SIGKILL)
 → runReap → EscalatingReaper.reap (reaper.ts:93)
     L0 cancel → L1 steer(≤5s) → L2 requestAbort(≤10s, session.abort→agent.abort→AbortSignal)
     → L3 dispose (agent-session.js:996: abortBash + agent.abort) → L3p killableHandles
```

pi 内置 bash（override 未生效时的回退路径，`dist/core/tools/bash.js`）：

- spawn：`bash.js:65` `detached: process.platform !== "win32"`（同为新进程组）
- abort/timeout：`bash.js:80/88` → `killProcessTree(pid)` → `dist/utils/shell.js:170-181`：`process.kill(-pid, "SIGKILL")` **立即整组 SIGKILL，无 TERM→KILL 升级**；失败时回退 `process.kill(pid, "SIGKILL")`（单 pid）。

## 3. 根因（区分已证实 / 推测 / 未核）

### 主根因【机制各环节已证实，端到端组合为高置信推测】

**`killJobTree` 的 SIGKILL 升级以「组长是否存活」为判据，而不是「组内是否还有成员」**（`src/bash/process.ts:456-467`）：

```ts
if (!signalGroup(pid, "SIGTERM")) return "already-dead";
const deadline = Date.now() + graceMs;          // 默认 2000ms
while (Date.now() < deadline) {
  await sleepUnref(...);
  if (!probePid(pid)) return "terminated";      // ★ 只探测组长 pid
}
if (!probePid(pid)) return "terminated";        // ★ 组长死了就返回，永不 SIGKILL
signalGroup(pid, "SIGKILL");
```

在 `npm test` 链上：组长（bash→npm）**没有 SIGTERM handler，收到组 SIGTERM 后立即死亡** ⇒ 阶梯在第一次轮询（~50ms）就返回 `"terminated"`，**永远不发组 SIGKILL**。而组内成员 vitest worker 若未死于该 SIGTERM，就再没有任何机制去杀它们。

支撑证据（每条独立已证实）：

1. **[已证实·实验 run-vitest5]** 完整 `bash→npm→sh→vitest→N workers` 链全部同 pgid；`kill(-pgid, SIGTERM)` 后组长（npm）2s 内死亡；若随后 `kill(-pgid, SIGKILL)` 则无任何幸存者 —— 即「整组 SIGKILL」对本场景完全有效。
2. **[已证实·实验 run-vitest3]** 只杀主进程单 pid（非组）时，**正在跑长测试的 worker 成为 PPID=1 孤儿**（同 pgid 存活），空闲 worker 自行退出 —— 与用户观察「8 个 busy worker 全部孤儿、PPID=1」完全同构（全量测试时 8 个 worker 都在满载跑 → 8 个全孤儿）。
3. **[已证实·代码]** npm 侧 `@npmcli/run-script`（`run-script-pkg.js`）在 stdio 非 `inherit`（pi-toolkit 用 pipe）时不装 signal-manager，npm 对 SIGTERM 无 handler、即死；vitest 主进程/sh 同理。
4. **[已证实·grep]** vitest 2.1.9 stock worker bundle **不注册任何 SIGTERM handler**（`dist/worker.js:62-72` 仅 `--prof` 时注册；`workers/forks.js` 及其全部依赖 chunk 无 SIGTERM 字样）⇒ 默认 disposition=终止。tinypool 的 process worker **不处理父进程死亡/IPC 断开**（`tinypool/dist/entry/process.js` 无 disconnect 处理）⇒ 主进程死后 busy worker 不会退出。
5. **[已证实·代码]** 术语上「前台命令」在本仓库 override 下并不存在独立 spawn 路径：前台/后台 job 都是 `spawnJob` 同一 spawn（detached 新进程组），「转后台」只是工具调用提前返回 + 记录归属（`src/tools/bash-tool.ts:552-620`）；终止都汇到 `killJobTree`。

### 「worker 不理 SIGTERM」的原因【未核，两种候选推测】

我在本机无法用 stock vitest worker 复现「不理 SIGTERM」（busy worker 收单发 SIGTERM 也会死，实验 3）。用户场景的候选解释：

- **(a) 推测**：全量套件中某个被 worker 加载执行的测试代码在 worker 进程内安装了 SIGTERM listener（repo 1800+ 测试，未逐一核查；src/ 本体只有 hub 进程装 handler）。装了 listener 后 SIGTERM 默认终止行为被取消。
- **(b) 推测**：8×2.9GB≈23GB 触发 swap 抖动，worker 处于不可中断睡眠（D 状态），信号投递被推迟到系统调用返回（可解释「5–7 分钟」）。

两者 SIGKILL 都能解决（(a) 必杀；(b) 在 D 状态退出后立即生效）——与用户「要 SIGKILL 才死」一致。

### 次要缺陷（记录在案）

- **[已证实·pi 本体]** `killProcessTree` 的回退 `process.kill(pid, "SIGKILL")`（`shell.js:176-179`）：当 `-pid` 抛 ESRCH（组长已死而组成员还在，或 pid 非组长）时退化为单 pid 杀，同样会留孤儿。pi 本体行为，本仓库不可改。
- **[已证实·代码]** `AgentSession.abort()`（`agent-session.js:1941-1952`）不含 `abortBash()`——`_bashAbortControllers` 只服务 `executeBash()`（交互/RPC 斜杠命令路径）；bash **工具**的中断靠 `agent.abort()` → activeRun signal → 工具自己的 onAbort。对 override 而言该 onAbort 最终也进 `killJobTree`（同一缺陷）；对已转后台的 job，abort 信号与进程无关联（设计如此，靠 seal 链杀）。
- **[已证实·代码]** `child-registry.ts` 的 `boundedKillAll`（grace+3s backstop）只做分类（pending/alreadyDone），不再补杀——修好 killJobTree 前它是唯一兜底且不兜杀。

### 为什么主根因指向 override 而非 pi 内置路径

pi 内置路径是「立即整组 SIGKILL」——即便 worker 装 handler 也必死，无法产生用户观察。只有 override 的「TERM→按组长判活→条件 KILL」阶梯能同时解释：组长链（bash/npm/sh/vitest main）全灭（死于 SIGTERM，无 handler）+ worker 全孤（SIGTERM 无效）+ PPID=1。且用户 settings 下 override 确定在子会话生效（见调用链图第 2 节条件）。

## 4. 修复方案与落点文件

### 主修复：killJobTree 升级判据从「组长存活」改为「组内仍有成员」

`src/bash/process.ts`（`killJobTree`，443-468 行）：

1. SIGTERM 整组（不变）。
2. 轮询期改为探测「组内是否还有成员」而非只探组长：Linux 下扫描 `/proc/*/stat` 的 pgrp 字段（仓库已有先例：`src/sysload/top.ts` 的 /proc 扫描、本文件自己的 `readProcGroup`），有界（≤10k 项）。
3. grace 结束时若组内仍有成员 ⇒ 立即 `signalGroup(pid, "SIGKILL")` 后再扫一次确认；组空 ⇒ `"terminated"`。
4. **保留 §3.3 安全底线**：pid 复用防护——SIGKILL 前重扫成员并确认其 pgrp 仍等于本组 pgid（pgid 只要在组内还有成员就不可能被新进程复用为组长，`kill(-pid)` 不会误伤无关组）；非 Linux 或 /proc 不可读时维持现状（组长死即返回）并 WARN，宁可标记 orphaned 不误杀。

### 兜底（可选，低优先）

- `src/bash/child.ts` `killAllNonTerminal`（133 行）：`manager.kill` 返回后对非 `already-dead` 的 job 做一次组空校验，不空则补 `killJobTree`（修主修复后冗余，作防御层）。
- `src/bash/child-registry.ts` `boundedKillAll`：backstop 超时分类为 `pending` 时可再触发一次补杀（同样冗余）。

### 明确不改（pi 本体行为，仅记录）

- `dist/utils/shell.js` `killProcessTree` 的 ESRCH 单 pid 回退与无阶梯问题 → 上游 issue；本仓库 override 开启时本来就不走它。子会话扩展未激活（todo #27 `-e` 场景）才会落回内置路径——该场景已有 `child_extension_missing` 诊断。
- `AgentSession.abort()` 不含 abortBash：与工具路径无关，不动。

### 落点清单

| 文件                                             | 改动                                              |
| ------------------------------------------------ | ------------------------------------------------- |
| `src/bash/process.ts`                            | killJobTree 升级判据 + /proc 组成员扫描（主修复） |
| `src/bash/manager.ts`                            | （若需要）kill 结果分类微调，透传新 outcome       |
| `src/bash/child.ts`                              | 可选：killAllNonTerminal 组空校验兜底             |
| `src/bash/child-registry.ts`                     | 可选：backstop 补杀                               |
| `tests/integration/bash-kill-tree.test.ts`（新） | 见下节                                            |
| pi 本体 `dist/...`                               | 不可改，记录上游缺陷                              |

## 5. CI 集成测试设计（Linux-gated，自动 skip win32）

**fixture**（`tests/fixtures/` 或内联生成到 tmp）：

- `leader.mjs`：无任何信号 handler 的组长进程；`fork()` 一个 `worker.mjs` 子进程并把其 pid 写文件；然后 `setInterval` 保活。
- `worker.mjs`：`process.on("SIGTERM", () => {})`（**显式忽略 SIGTERM，精确模拟用户场景**）+ 长定时器保活 + pid 写文件。

**用例 1（ProcessPort 层）**：`createProcessPort().spawnJob("exec node leader.mjs")` → 等 pid → `killJobTree(pid, {graceMs: 500})` → 断言：outcome ∈ {terminated, killed}，且轮询 ~3s 内「pgid === job pgid 的进程数为 0」（扫 /proc）且 worker pid 已消失。`finally` 兜底 `kill(-pgid, SIGKILL)` + `kill(workerPid, SIGKILL)`。

**用例 2（Manager 层）**：同一 fixture 走 `createBashJobManager().create()` + `manager.kill(jobId)`，断言 record 终态 + 进程全灭（覆盖 seal→killAllNonTerminal 的直连等价物）。

**用例 3（E2E，可选慢测）**：真实 stack + fake model：子 run 的 bash 调用 `run_in_background:true` 跑 fixture → 用极小 `budgetOverride.totalMs`（如 3s）触发 total 超时 → `await` run() 返回 `timed_out` → 断言 seal grace+slack（≤6s）内组空。钉死整条 seal→killAllNonTerminal→killJobTree 链。

**断言核心都是「无残留进程」**，且所有用例必须在 finally 里按记录的 pid/pgid 自清理（测试自身绝不依赖被测逻辑来清理）。

## 6. 风险

1. **安全教义张力（最大风险）**：§3.3「宁可泄漏不误杀」。组长死后补发组 SIGKILL 存在理论 pid 复用窗口（组长 pid 被新进程复用且恰好成为组长）。缓解：SIGKILL 前即时扫描确认组内仍有 pgrp==pgid 的成员（有成员 ⇒ pgid 不可能被复用）；非 Linux/不可读 /proc 时维持旧行为。
2. **kill 时延变化**：升级不再在组长死亡时提前返回，最长多耗 graceMs（默认 2s）。`sealAndKill` 的 killAll 是 fire-and-forget，registry backstop（grace+3s）只影响分类上报，不会挂起调用方；`BASH_JOB_SEAL_GRACE_MS`（2000）与 killJobTree 默认 grace 相等，需确认「扫描+SIGKILL+复扫」在 backstop 内完成或明确允许后台完成。
3. **outcome 语义变化**：原先报 `terminated`（假象）的场景现在可能报 `killed` —— 依赖 outcome 的测试/分析需同步更新。
4. **「worker 不理 SIGTERM」根因未核**（handler vs D 状态）：两种情况下 SIGKILL 均有效，修复均成立；但若根因是 (a) 测试代码装 handler，值得另行定位（可能在全量套件里加一个「worker 无多余 signal listener」的守卫断言）。
5. **未核项清单**：① 用户实际 run 的 budgetOverride/timeout_s（决定 R 与 D 的确切值，不影响结论）；② 全量套件中是否有代码在 worker 内装 SIGTERM listener；③ 端到端复现（用真实 1800 测试 + 短 total budget 重放）——修复后的集成测试 fixture 已用「显式忽略 SIGTERM 的孙进程」覆盖该形状。
