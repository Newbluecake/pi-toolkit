## J7 交付报告

J7 已完成：门禁（④）全链路和端口生产接线都已落地，自验全部通过。有一处越界改动（root 已批准）。另有一个 J2 client 的问题需要 root 处理，见末节第 1 条。

### 1. 文件清单（绝对路径，行数）

- 新建 `/home/bluecake/ai/pi-toolkit/src/memory/jev/probes.ts`（361 行）
- 新建测试，共 1759 行：
  - `/home/bluecake/ai/pi-toolkit/tests/memory/jev/probes.test.ts`（399）
  - `/home/bluecake/ai/pi-toolkit/tests/memory/jev/wire-gate.test.ts`（604）
  - `/home/bluecake/ai/pi-toolkit/tests/integration/memory-jev-gate.test.ts`（276）
  - `/home/bluecake/ai/pi-toolkit/tests/integration/memory-jev-release-guard.test.ts`（227）
  - `/home/bluecake/ai/pi-toolkit/tests/integration/memory-jev-write.test.ts`（253）
- 只追加修改（numstat 增/删）：
  - `/home/bluecake/ai/pi-toolkit/src/memory/jev/wire.ts`（+534/−15）
  - `/home/bluecake/ai/pi-toolkit/src/memory/index.ts`（+57/−2）
  - `/home/bluecake/ai/pi-toolkit/src/index.ts`（+4/−1）
  - `/home/bluecake/ai/pi-toolkit/tests/memory/jev/off-golden.test.ts`（+6，只动 `PI_API_ALLOWED_DIFF`）
- **越界改动（root 已批准）**：`/home/bluecake/ai/pi-toolkit/tests/memory/wire.test.ts`
  - 第 257 行断言改为 `MEMORY_TOOL_V2_TEXT_JEV.description`，第 15 行 import 补上该常量，文件其它内容未动。
  - 理由：jev 默认开启，生产接线后默认设置下工具描述按 arch §9.3 换成变体，这是本包有意的行为变化。
- 没碰的文件：`segment.ts`、J1/J2/J4/J5/J8 的文件、所有 golden。没有 commit。

### 2. 导出对照 §2

- `collectEvidence(input)`：§2 的字段都在，另加：
  - 必填 `procCache`（I4：缓存是闭包实例）；
  - 可选 `parsed`、`uid`、`fs`（测试缝）。
  - 并行采集，`EVIDENCE_BUDGET_MS=1500`，任一项失败省略，永不 reject。
- `scanProc(procRoot, uid, wanted, cache, opts?)`：签名同 §2，`opts` 里有 `fs`/`now`/`deadlineMs`/`maxPids`。只扫当前 uid、≤4096 pid、缓存 2s、扫描截止 1.5s、永不抛错。
- `readGitHead(cwd, fs?)`：向上找 `.git`，支持 worktree 的 `gitdir:`（相对/绝对路径），detached 时返回 `detached@sha7`。
- `stagedFiles(git, cwd)`：最多 50 条，非 0 退出 / 超时 / spawn 失败时省略，输出超限只保留完整行。
- `evidenceFingerprint(ev)`：sha1（排序后的程序身份 + branch + 排序后的 staged），与命令行标签无关。
- **偏差**：`clearProcCache(cache)` 必须传入缓存实例，因为 I4 禁止模块级状态。
- 额外导出：
  - `probes.ts`：`createProcCache`、`commandShape`、`isGitCommit`、`hasPathLikeWord`、`SAFE_PROBE_FS`、`ProbeFs`；
  - `wire.ts`：`GATE_WAIT_MS`；`WireJevDeps` 新增可选 `git`/`procRoot`/`probeFs`/`uid`/`coreUsageLine`；
  - `memory/index.ts`：`jevBashJobsFrom`、`BashJobRecordLike`、`jevSettingsWarnings`。

### 3. 门禁全链路（wire.ts 的 `tool_call` handler：先门禁，后 A 层）

| 环节                   | 实现                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 粗筛五步（同步）       | ① 状态非 off、非 inactive，且 `gate.enabled`<br>② 只读工具集：read/grep/find/ls/web_search/get_run_result/todo*/Task*、memory view/search<br>③ 至少命中一个 `risk:"high"` 标签（基于 shell-parse）<br>④ 守护条目：`guarded`，且共享命中标签或写了行内 `gate*`；排除 private/secret；按重要度、user 优先，最多 8 条<br>⑤ 剔除本段已闩锁的非 hold 条目<br>不通过时 handler 同步返回 `undefined`，不创建 Promise（测试断言 `callRaw()===undefined`） |
| 证据                   | `probes.collectEvidence`：bashJobs（仅主会话）+ `/proc`（仅 Linux）+ HEAD + staged                                                                                                                                                                                                                                                                                                                                                                |
| 判定档（full/probing） | `buildGateQuestions` → `client.ask(duty "gate", sync)`，预算 = 2500ms 截止时间减去已用时间；`decideGate` 表四行逐行有测试                                                                                                                                                                                                                                                                                                                         |
| 证据档                 | Jev 超时 / 出错 / 漏答 / partial 时：`evidenceTier`，`gate=hold` 且点名程序在跑才拦，reason 为「Jev 未判定（why），按证据拦截」；其余放行，并注入 `[memory · G unjudged]`（每段每条目一次）                                                                                                                                                                                                                                                       |
| 缓存                   | `verdictKey(hash, fp, shape)`。命中时用缓存的 a/v 加当前闩锁状态重跑判定表，不调 Jev。compaction 和 `session_start` 清空；`/mem jev` 的 `verdictCache` 改为真实大小                                                                                                                                                                                                                                                                               |
| 闩锁                   | 拦截（once 和 hold）后 `segment.latch(hash, turnSeq)`，`turnSeq` 前进后才生效（同一批里的调用仍被拦）。hold 也闩锁，这样条件消失后走第 4 行放行                                                                                                                                                                                                                                                                                                   |
| 串行                   | 按条目 hash 的 Promise 链锁，在第一个 await 之前同步登记（C-J3）                                                                                                                                                                                                                                                                                                                                                                                  |
| 文案                   | 用 `formatGateReason` 的 once / hold / hold-evidence 和 `formatUnjudged`。多条命中时取最严判定，追加「（同时命中：…）」                                                                                                                                                                                                                                                                                                                           |
| 静态 core              | 不重复注入正文，reason 引用条目标题                                                                                                                                                                                                                                                                                                                                                                                                               |
| 异常                   | 同步段 try/catch，异步段 try/catch 加 `.catch`，异常一律放行并记日志（C-J2）；两种情况都有测试                                                                                                                                                                                                                                                                                                                                                    |

`bash-job:notification` 到达时清 `/proc` 缓存，`message_start` 和 `before_agent_start(custom)` 两条路径都处理。

### 4. release.sh 场景（`memory-jev-release-guard.test.ts`，生产装配）逐步结果

1. 后台任务 job_42 运行中，执行 `git add -A && git commit`：被 hold 拦，violates_now 0.86，证据 `job_42 (3m) … release.sh 0.10.3`。Jev 的 state 里 programs 为 `["git add","git commit"]`，token 已掩码（D7 ①）。✅
2. 重试：命中缓存，Jev 调用数仍为 1，正文没有再注入。✅
3. `git -C . commit`：被拦。✅
4. `echo "git commit"` 和 `grep "git push" README.md`：同步放行，Jev 调用数不变。✅
5. 任务完成，收到通知，`turn_end` 后的下一次提交重新判定（state.running 为空），放行。✅
6. Jev 永不返回的版本：约 2.5s 内按证据拦截，reason 为「Jev 未判定（timeout），按证据拦截」。✅

### 5. 四个核对项

1. **误拦形态**：粗筛先过 shell-parse 再匹配标签，所以 `echo`/`grep`/`printf` 的程序是它们本身，不会命中 `git-commit`/`git-push`。wire-gate 与 release-guard 两个测试都断言：同步返回、零 await、零 Jev 调用、零 git 调用。
2. **J6 遗留（E 层）**：J6 报告的前提不成立。我用真实 AgentSession 实测：流式中经 steer 送进来的 bash-job 通知**会触发 `message_start`**（带 customType，位于 toolResult 之后、同一个 run 内；pi-agent-core 的 agent-loop 会对每条 steering 消息 emit）。所以 J6 现有的 `message_start` handler 已经覆盖这条 E 层路径，不需要靠 bashJobs 端口轮询；而且该端口按冻结契约也没有 exitCode 和输出可供 E 层用。已在 `memory-jev-gate.test.ts` 补真实会话测试钉住；`wire.ts` 的 E 层逻辑没改。
3. **core 用量（J8 major）**：没有改 J8 的文件。
   - `wireMemory` 给 `wireJev` 传入 `coreUsageLine`，取 doctor 的 D19 判定；doctor 端口在 `extraReminder` 里追加 `memory: core usage — <D19 message>`。
   - 只在 ≥80% 时出现（与 D19 同条件），否则启动提醒每次都会触发。
   - 测试覆盖：≥80% 时出现这一行，低于时不出现。
4. **写端口依赖**：`createJevWritePort` 从 `makeWritePort` 注入，`entryIndex`/`taxonomyFor`/`dirFor` 都来自 wire 闭包。`tool-v2` 的 registry 检查只看两个方法，`wire` 看三个，口径原本不一致。我没改 `tool-v2.ts`，而是在 `makeWritePort` 外包一层，用 wire 的三方法检查收窄后再传给 `afterWrite`。效果是统一的：缺 `getModelOfType` 时写路径也按 off(pi-api) 处理、零调用（有测试）。另外 `afterWrite` 完成后清掉 2s 语料缓存，这样新打的标签对下一次 A 层和门禁立即可见。

### 6. 生产接线清单

- `memory/index.ts`：
  - `createMemoryToolV2({…, jev: jev.makeWritePort()})`；
  - 启动提醒拿到延迟绑定的 doctor 端口，注册位置不变，所以 trace 无 diff；
  - `doctorSummary` 带 jev 端口；
  - Q34：全部非法时给 `settingsWarnings` 一行 `memory.jev.classifiers: all entries invalid (foo) — jev off`（每个 session 去重，有测试）；空列表时不提示，与 disabled 一致（有测试）。
- `src/index.ts`（post-guard）：`memoryWiring?.attachJevBashJobs(jevBashJobsFrom(() => holder.current?.bashJobs?.list() ?? []))`。
- `createMemCommand` 的 deps 不接收 doctor 端口，`/mem doctor` 继续用 J8 的 `jevDoctorPortFrom`（只看端口在不在），D17–D19 都能出现（有测试）。

### 7. off / pi-api 证据

- 四个设置期 off 配置与 golden 逐字节一致，`off-golden.test.ts` 8/8 通过。
- pi-api 的允许差异只追加了两项：
  - `tool-description:memory`
  - `tool-line:jev: not tagged (off: pi-api)`
- **root 追问的结论**：默认设置下宿主不是 off(pi-api) 时，工具描述**仍是变体**。依据：
  - arch §8：描述变体「由设置决定，在一个 activation 内保持不变」；
  - plan §1.1：pi-api 只能在运行时按 ctx 得知，而工具注册发生在任何 ctx 之前；
  - J0 允许差异清单本身就预列了 `tool-description` 这一项。
  - 已在 `memory-jev-write.test.ts` 补断言。
- `governance/activate-trace.json` 无 diff，本包没有新增 `pi.on`/`register*`。

### 8. 自验输出（真实结果）

- J7 第 7 条的 vitest 命令：`Test Files 35 passed (35)` / `Tests 660 passed (660)`
- `timeout 900 npx vitest run tests/memory tests/conformance/memory-jev-channels.test.ts tests/web-hub/agent/command-policy.test.ts`：`Test Files 75 passed (75)` / `Tests 1562 passed | 1 skipped (1563)`
- `npm run typecheck`：exit 0。`npm run format:check`：All matched files use Prettier code style!
- `git diff --stat HEAD -- tests/fixtures/`：空。
  - `git diff --stat origin/dev -- tests/fixtures/` 列出 activate-trace / memory-tool-surface / jev-off-golden 三个文件，全部来自未推送的 J0/J5/J6 提交。
- `/proc` 基准（只记录，Linux 5.15，16 核）：

| 场景                            | 冷扫描     | 缓存命中 |
| ------------------------------- | ---------- | -------- |
| 本机真实 332 pid                | 9.9–14.5ms | 0.07ms   |
| 磁盘合成 4096 pid（经 safe-fs） | 116–156ms  | —        |

### 9. 遗留与上报事项

1. **J2 client（需要 root 处理）**：单次尝试超时（总预算的一半）被记为 `aborted`，直接失败，不会切换到第二个分类器。这对所有同步职责都有影响。门禁里我已把「非本方 abort」映射为 timeout，再走证据档。
2. `hasPathLikeWord` 比较宽松（`commit/tag/` 这类也算），会多跑一次有界的 git 调用（≤1s）。
3. 粗筛读语料走同步 IO（2s 缓存），与 A 层同一机制；arch 写的是「零 IO」，这里是近似实现。
4. 启动提醒取 core 用量时会再跑一遍 doctor。
5. 按「永不外发」，secret 条目不参与门禁。
6. `/proc` 进程与 bash job 按命令行文本去重。
7. 没跑全量测试（由主会话执行）。
