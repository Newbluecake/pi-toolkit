# Jev Reflex R2a · 只读 ports 交付报告

日期：2026-11-05。基线：dev 上 R0 `ab14948b`。范围：plan §4 R2a，语义按 arch §4.6；PD4 值闭包 pi-free。未提交、未运行任何 git add/commit/stash/checkout/reset/restore，未修改冻结面或 fixtures。

## 文件清单（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/reflex/ports/index.ts`：填四个 port registry、动态 capabilities、临时预算竞速。
- `/home/bluecake/ai/pi-toolkit/src/reflex/ports/jobs.ts`：jobs.list。
- `/home/bluecake/ai/pi-toolkit/src/reflex/ports/fleet.ts`：fleet.status。
- `/home/bluecake/ai/pi-toolkit/src/reflex/ports/quota.ts`：quota.summary。
- `/home/bluecake/ai/pi-toolkit/src/reflex/ports/git.ts`：git.status、冻结 argv。
- `/home/bluecake/ai/pi-toolkit/src/reflex/core/git-status-parse.ts`：纯 porcelain-v2 NUL 解析器。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/helpers.ts`：类型化只读依赖和 porcelain 夹具。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/registry.test.ts`：registry、动态能力、内存 ports 渲染和只读断言。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/execute-port.test.ts`：成功、异常、超时、abort、计时器清理/unref。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/git.test.ts`：argv、选项、退出语义、路径截断。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/git-status-parse.test.ts`：纯解析器 17 个用例。
- `/home/bluecake/ai/pi-toolkit/tests/reflex/ports/git-real.test.ts`：Tier 2 真 git、index mtime/字节不变、无 lock。
- `/home/bluecake/ai/pi-toolkit/docs/dev/jev-reflex/R2a-report.md`：本报告。

## 输出、失败语义和预算

全部 port `version:1`。`sessions.recent` 尚不注册，也不广告 `sessionDir`。`capabilities()` 每次读取 getter；git 恒有，manager 消失/替换实时反映。port 工厂不读 manager、不发请求。

### jobs.list

仅 `bashJobs()?.list()`。非终态（含 staged）算 running，终态且 `notifiedAt === undefined` 算 finished unread；已通知终态不列行，但计入 total。

```text
bash jobs (1 running, 1 finished unread):
  b_one running 1m00s  npm test
  b_done completed (exit 0) 5s  npm test
```

每组最多 8 行（合计 16 行 + 首行）；有遗漏置 `truncated:true`。0 jobs 为 `ok/lines:[]`，供 render 使用 emptyText。facts 是 `{running, unread, total}`。耗时从 spawnedAt（缺省 createdAt）到 endedAt（缺省 env.now）。命令先 `redactForJev(...,"command")`，再 `previewCommand(...,80)`，状态和耗时分别使用 `describeJobStatus` / `formatDuration`；不 import `renderBashJobsSection`。

manager 缺席为 `unavailable("bash jobs unavailable")`。list 抛错由 executePort 转 error，不伪装为空。

### fleet.status

仅 `fleet()?.list()`。首行包含全部八种状态计数；随后只列非终态前 8 条：

```text
fleet (1 queued, 1 starting, 1 running, 1 stopping, 1 completed, 1 failed, 1 timed_out, 1 aborted):
test · queued · 1m00s
main · starting · 1s
```

label 缺省用 `displayAgentType(diag.agentType)`（legacy consult sentinel 转 main），再缺省 runId。耗时从 startedAt/enqueuedAt/createdAt 顺次回退到 env.now。facts 为各状态计数，不含 label、命令、路径。空 fleet 为 `ok/lines:[]`；活跃 >8 置 truncated。query 缺席为 `unavailable("fleet unavailable")`；不调 wait/steer/stop 或 runner。

### quota.summary

仅 `quota()?.verdicts(env.now)`，使用服务既有可信快照过滤，绝不 refresh。

```text
kimi-coding 5h 25%
zai
```

每 provider 一行，原样调用 pi-free `renderProviderLine`，facts 为 `{providers:N}`，truncated=false。服务缺席为 `unavailable("quota unavailable")`，verdicts 空为 `uncertain("no trusted snapshot")`，不凭缺席数据推断额度充足/耗尽。

### git.status

调用注入的 `GitRunner`（装配来自既有 `src/git/run.ts`），不另建执行器或 shell。冻结 argv 逐字节钉住：

```text
--no-replace-objects --no-pager --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false status --porcelain=v2 --branch -z --untracked-files=normal
```

opts：cwd 原样作为选项（不拼 argv）、timeoutMs 经 clampSpanMs 且最多 1200、maxStdoutBytes=65536、envPolicy=minimal、pathOverride=WTDIFF_GIT_PATH、原 signal。`run.ts` 本身保留硬期限/输出上限/进程组 kill/unref，未改它。与 hub VERSION_GIT_PREFIX 的差异及 I8 不跨层 import 理由写在 git.ts 注释。

脏状态格式：

```text
dev · upstream none · ahead 0/behind 0
staged 1/modified 1/untracked 20/unmerged 0
file
new 0
...
```

最多 15 个路径，超过置 truncated。rename 消费第二个 NUL 路径并列新/旧路径；同一 tracked 条目的 index/worktree 变化独立计数；unmerged 单独计数。facts 为 branch/ahead/behind/staged/modified/untracked/unmerged/clean，不存 paths。**root 已批准偏差**：始终输出首行分支摘要（branch + upstream + ahead/behind），无 upstream 明确写 `upstream none`，detached 显示 `HEAD (detached)`；干净时第二行输出 `working tree clean`（emptyText 语义），不返回 lines:[]。脏状态第二行显示改动计数，之后最多 15 个路径。facts 不变。

| Runner 结果                    | PortOutcome                                            |
| ------------------------------ | ------------------------------------------------------ |
| stdoutCapped / killed=overflow | error("overflow")                                      |
| killed=timeout                 | error("timeout")（不是 executePort 的 timeout/budget） |
| killed=abort                   | error("aborted")                                       |
| code=128 / spawnError          | unavailable("git unavailable")                         |
| 其余非零或 null code           | error("exit")                                          |
| code=0，但格式无效             | error("parse")                                         |
| code=0，格式有效               | ok                                                     |

解析器严格检查 NUL 终止、branch oid/head 头、重复/未知头、ahead/behind 安全整数、记录元数据、rename 第二路径；非法输出抛异常后映射 parse error。支持 initial、detached、sha1/sha256、带空格/换行/tab 的不透明路径、unmerged、submodule；ignored 路径不计入变更。

### executePort（本包临时预算竞速）

- 不 import R1 `core/budget.ts`，只依赖 core Clock/deadline；R2a′ 再收敛。
- `clampSpanMs(min(env.budgetMs,1200))`；非法预算立即 `timeout("budget")`，不调用 port；Infinity 被顶到 1200。
- 同步 throw、rejected promise 映射 `error("exception")`，不把原异常内容/秘密写进 reason。
- 预先或在飞 abort 映射 `error("aborted")`；原 signal 传给 port，shutdown 可杀 git。
- 预算到点是 ExecOutcome `timeout/reason:"budget"`。晚到结果忽略，晚到 rejection 已挂 rejection handler。
- Clock 负责 unref/分段；所有正常 settle 清 timer 和 abort listener。坏的注入 clock 在 setup/cleanup 抛错也退化 error，不导致悬空 Promise。
- 内存 ports 同步读取，统一通过 executePort 受同一预算约束；它不是可抢占的同步 CPU 执行器，不声称能中断阻塞 JS。

## 只读证据

- 单测 spy fs 同步/Promise 写 API，`syncBuiltinESMExports()` 使 named/default builtin 导入同时受 spy 监控：零调用。
- fetch spy 零调用；quota refreshIfStale spy 零调用。
- Proxy 记录实际方法访问恰为 jobs.list/fleet.list/quota.verdicts；manager 返回的记录前后深比较不变。
- 真 git 测试只在 os.tmpdir 下 git init；为了不运行 git add/commit，测试本地合成有效 SHA1 loose blob + v2 index，制造 tracked/staged/modified 文件。断言实际读数 staged=1、modified=1、untracked=1、branch=reflex-test；index mtimeNs 和字节运行前后不变，index.lock 不存在。
- ports 与 parser 值闭包 pi-free 门禁、既有 off golden 均通过。

## 自验命令及真实输出

长输出使用 `set -o pipefail` + tee 保留全文，不使用 tail 截断。定向测试统一 `PI_TOOLKIT_TEST_WORKERS=2`，未跑全量 npm test。

### 指定定向命令（最终一次）

```sh
timeout 180 env PI_TOOLKIT_TEST_WORKERS=2 npx vitest run tests/reflex/ports tests/boundary/pi-free.test.ts tests/integration/reflex-off-golden.test.ts 2>&1 | tee /tmp/reflex-R2a-tests.log
```

```text
 RUN  v2.1.9 /home/bluecake/ai/pi-toolkit
 ✓ tests/reflex/ports/registry.test.ts (6 tests) 17ms
 ✓ tests/boundary/pi-free.test.ts (30 tests) 541ms
 ✓ tests/reflex/ports/execute-port.test.ts (13 tests) 13ms
 ✓ tests/reflex/ports/git.test.ts (16 tests) 12ms
 ✓ tests/reflex/ports/git-real.test.ts (2 tests) 23ms
 ✓ tests/integration/reflex-off-golden.test.ts (2 tests) 177ms
 ✓ tests/reflex/ports/git-status-parse.test.ts (17 tests) 10ms
 Test Files  7 passed (7)
      Tests  86 passed (86)
   Start at  05:36:45
   Duration  6.97s (transform 4.22s, setup 206ms, collect 6.59s, tests 792ms, environment 1ms, prepare 381ms)
```

退出 0。off golden stderr 有既有 settings migration / renderer unavailable / 测试环境缺 quota credential 提示，全文在日志；无失败。

首跑 3 个测试 harness 问题：Vitest 2 不支持 toHaveBeenCalledExactlyOnceWith（改显式次数+参数断言）、ESM namespace fs 不能 redefine（改 default builtin spy，并同步 named exports）。修复后通过，未改被测语义。

### 类型检查

```sh
timeout 180 npm run typecheck 2>&1 | tee /tmp/reflex-R2a-typecheck.log
```

```text
> pi-toolkit@0.10.5 typecheck
> node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.json && node node_modules/typescript-7/bin/tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

退出 0，无诊断。

### 构建（额外执行）

```sh
timeout 180 npm run build 2>&1 | tee /tmp/reflex-R2a-build.log
```

```text
> pi-toolkit@0.10.5 build
> node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle
> pi-toolkit@0.10.5 build:bundle
> node scripts/build-bundle.mjs
build:bundle ok — dist/bundle/index.js sha256=fe1df19d0bf7618c size=4.63 MB time=184 ms inputs=675
```

退出 0，dist 为 gitignored 产物。

### 格式与冻结面

```sh
timeout 120 npx prettier --check src/reflex/ports/*.ts src/reflex/core/git-status-parse.ts tests/reflex/ports/*.ts docs/dev/jev-reflex/R2a-report.md
git diff --check
git diff --quiet origin/dev -- tests/fixtures/
```

格式检查退出 0（全文 `/tmp/reflex-R2a-format.log`）：

```text
Checking formatting...
All matched files use Prettier code style!
```

`git diff --check` 退出 0。**origin/dev fixtures 对比退出 1**：远端基线尚未包含本地 R0，其差异恰为 R0 的 `tests/fixtures/governance/activate-trace.json` 与新增 `tests/fixtures/reflex-off-golden.json`，不是本包变更。进一步实测 `git diff --quiet HEAD -- tests/fixtures/`、`git diff --quiet ab14948b -- tests/fixtures/` 均退出 0，证明 R2a 相对已批准 R0 未改任何 fixtures。已 message_agent 向 root 报告这个基线差异。

## 偏差、开放项和下包交接

1. **无 types.ts 追加，无冻结面变更，无 R1 文件改动。** 源码与测试总计约 1,000 行；比计划估计的总 ~700 行略多，主要增加严格 malformed-output / 只读 / timer cleanup 测试。
2. **已批准偏差表（root 裁定，2026-11-05）**：

   | 对比项    | arch §4.6                        | root 裁定及本包实施                                                                                                      | 测试                                                  |
   | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
   | clean git | 使用 emptyText，可返回 lines:[]  | 始终先输出分支摘要，随后 `working tree clean`，不返回 lines:[]                                                           | git.test.ts clean 逐字段/逐字节断言                   |
   | 分支摘要  | branch · ahead/behind · 改动计数 | 首行 branch + upstream + ahead/behind，改动计数单独第二行；无 upstream 写 `upstream none`；detached 写 `HEAD (detached)` | upstream/ahead-behind、detached、initial 三个定向用例 |
   | facts     | branch 与计数                    | 不变，不追加 upstream/path 字段                                                                                          | clean 完整 facts 相等断言，dirty facts 匹配断言       |

   原因：git.status 同时回答“当前分支是什么”，工作区干净时不能丢分支信息。已按 root 明确裁定闭合，无待裁决项。

3. **README 由 root 更新**：本包独占文件域未含 README，已 message_agent 说明；此报告承载 R2a 实现细节，避免并行包写冲突。
4. **R2a′ 必须做**：原 owner resume，将 index.ts 临时竞速收敛到 R1 raceBudget；保留 execute-port 同组测试验证行为不变，不在本包提前 import R1。
5. **无全量测试声明**：按并行资源禁令只跑指定定向命令；全量由 root 在集成验收时单份执行。本包 ports 总计 54 个测试全部通过（86 减去 pi-free 30/off golden 2）。
