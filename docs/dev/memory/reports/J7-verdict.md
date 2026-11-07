eId":"J7","report":"## 验收结论：通过（pass）

J7（门禁 ④ 与端口生产接线）逐条验收通过。所有证据来自亲手读取的代码（文件:行号）与亲手运行的命令；开发报告仅作线索，未采信其结论。

## 验收矩阵

### A. 文件域与红线

| #   | 验收点                                                                  | 结论 | 证据                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 只含 J7 声明的改动                                                      | ✅   | `git status --short`：改 `src/index.ts`、`src/memory/index.ts`、`src/memory/jev/wire.ts`、`tests/memory/jev/off-golden.test.ts`、`tests/memory/wire.test.ts`；新建 `src/memory/jev/probes.ts`、`tests/memory/jev/{probes,wire-gate}.test.ts`、`tests/integration/memory-jev-{gate,release-guard,write}.test.ts`、报告。无其它文件 |
| A2  | J1/J2/J4/J5/J8 文件、`jev/segment.ts`、tiered/legacy/doctor golden 未改 | ✅   | git status 未列出任何这些文件；`decide.ts`/`format.ts`/`questions.ts`/`client.ts`（除已提交的 510a0678）/`segment.ts` 均无工作树改动                                                                                                                                                                                              |
| A3  | `tests/fixtures/` 无 diff                                               | ✅   | `git diff HEAD -- tests/fixtures/` = 0 行。vs origin/dev 的 3 个文件（activate-trace 22 行、memory-tool-surface 4 行、jev-off-golden +1475）经 `git log origin/dev..HEAD -- tests/fixtures/` 确认全部来自 J0/J5/J6 已提交 commit，非 J7 工作树                                                                                    |
| A4  | off-golden 只追加 `PI_API_ALLOWED_DIFF`                                 | ✅   | diff 仅 +6 行：`tool-description:memory`、`tool-line:jev: not tagged (off: pi-api)` 两 token + 注释（off-golden.test.ts:91-96）                                                                                                                                                                                                   |
| A5  | wire.test.ts 越界仅一处断言                                             | ✅   | diff = import 行补 `MEMORY_TOOL_V2_TEXT_JEV`（15 行）+ 257 行断言改为变体，其余未动（root 已批准，import 为必要伴随改动，报告 §1 已披露）                                                                                                                                                                                         |

### B. plan J7 第 5 条验收标准

| #   | 验收点                                                              | 结论 | 证据                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 粗筛四类零 await（同步返回）                                        | ✅   | wire.ts `gateCoarse`（同步、无 await）；wire-gate.test.ts:264-332 五个测试断言 `callRaw()===undefined`（echo/grep/printf 误拦形态、只读工具、无高危命中、无守护条目、闩锁后放行），并断言零 Jev/零 git 调用                                                                                                                                          |
| B2  | 判定档四行 + 缓存不调 Jev + hold 正文一次 + turnSeq 闩锁 + 同批双拦 | ✅   | decide.ts:249-266 四行表逐行有测试（wire-gate.test.ts:347-455：a+v<thr 放行、hold∧v≥thr、once 未闩锁、闩锁后第 4 行放行）；重试 gateCalls 恒 1（缓存）；hold 3 次重试 gMessages 恒 1；`segment.isLatched` 语义 `turnSeq > at`（segment.ts:172-175）；同批两个 `callRaw` 并发均 block、1 次 Jev、1 次正文（Promise 链锁 wire.ts `acquire`，同步登记） |
| B3  | 证据档两行 + 文案 + unjudged 每段每条目一次                         | ✅   | evidenceTier（decide.ts:277-293）两行；hold-evidence 文案「Jev 未判定（why），按证据拦截」（format.ts:117-121，与 arch §6.4.5 示例一致）；`[memory · G unjudged] Jev 未能判定，以下规则请自行核对`（format.ts:123-126）；每段每条目一次由 `segment.isInjected`+`markInjected("G")` 保证，测试：两次调用仅 1 条 unjudged、内容含两条规则正文          |
| B4  | nogate 永不拦；行内 gate* 任意高危候选；静态 core                   | ✅   | gateCoarse 步骤 4 `!meta.guarded ⇒ continue`（nogate ⇒ 永不 guarded）；wire-gate.test.ts:457-471（nogate 条目 `git add -A` 不拦、B 条目无标签仍拦）；静态 core 测试：gMessages 0、reason 含「pitfalls.md › Commit」标题                                                                                                                              |
| B5  | 证据细节：点名程序/他人 uid/pid 消失/非 Linux/子会话/脱敏           | ✅   | probes.test.ts:87-135（`vim …/release.sh` 身份是 vim 不收录；他人 uid 0 忽略；消失 pid 跳过；扫描永不抛）；probes.test.ts:294-361（非 Linux 只 bashJobs、child 无 bashJobs、`ghp_` token 不出现在任何 JSON 输出、running≤10、label≤120 码点）；release-guard D7① 断言 TOKEN 不进 Jev state 与 reason                                                 |
| B6  | 同步等待 ≤2500ms（fake clock）                                      | ✅   | wire-gate.test.ts:596-614：hang 与 hang-forever 两模式均在 GATE_WAIT_MS=2500（wire.ts:163）内落证据档；release-guard 实钟版 <2900ms                                                                                                                                                                                                                  |
| B7  | release.sh 场景全套                                                 | ✅   | memory-jev-release-guard.test.ts:170-200 六步：hold 拦（violates_now 0.86，证据 job_42）→ 重试命中缓存（Jev 调用仍 1、无新正文）→ `git -C . commit` 拦 → `echo "git commit"`/`grep "git push"` 同步放行零 Jev → 完成通知+turn_end 后重判放行（state.running 空）→ hang 版按证据拦「Jev 未判定（timeout）」                                           |
| B8  | 生产接线：描述变体/写后回显/D17-19/启动提醒/off golden              | ✅   | memory-jev-write.test.ts:88-127（生产装配描述=MEMORY_TOOL_V2_TEXT_JEV、create→打标→回显 `jev: pitfall 0.90`/`tags git-push 0.90`→侧车 index 落盘→A 层可见且零调用）；:130-151（缺 getModelOfType 的 registry ⇒ 写路径 off(pi-api)、零调用、描述仍变体——与 arch §8 一致）；doctor D17/D18/D19 出现（:167-183）；off-golden 8/8 绿（主命令）           |
| B9  | Q34 两种配置                                                        | ✅   | memory-jev-write.test.ts:225-253：`classifiers:"foo"`（全非法）⇒ 不接线 + 启动提醒恰一行 `memory.jev.classifiers: all entries invalid (foo) — jev off`（两次 session_start 去重）；空列表 ⇒ notes 与 disabled 逐字节相等、无提示行                                                                                                                   |
| B10 | governance 无 diff                                                  | ✅   | tests/governance 3 passed；本包未新增 `pi.on`/`register*`（门禁挂在 J6 已注册的 tool_call handler 内）；fixtures vs HEAD 0 行                                                                                                                                                                                                                        |

### C. 四个核对项（看代码与测试）

| #   | 核对项                                | 结论                    | 证据                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | ① echo/grep 误拦形态零 await 不问 Jev | ✅ 落实                 | 粗筛第 3 步基于 shell-parse 的 matchTags：`echo "git commit"` program 是 echo（实测见 D 节）；wire-gate misinterception 测试断言同步 undefined + 零 Jev + 零 git；release-guard #4 实钟复验                                                                                     |
| C2  | ② 流式 bash-job 通知给 E 层供数       | ✅ 已覆盖（无需新代码） | memory-jev-gate.test.ts:246-276 用真实 AgentSession 钉住：流式中经 steer 送入的 bash-job 通知会触发 `message_start`（customType 位于 toolResult 后、同一 run 内），J6 既有 message_start→bashNotice→recallE 路径已供数；bashJobs 端口按冻结契约无 exitCode/输出可用。论证成立   |
| C3  | ③ 启动提醒补 core 用量行              | ✅ 落实                 | `wireMemory` 传 `coreUsageLine`（memory/index.ts:215-222，取 D19 判定）→ wire.ts extraReminder 追加 `memory: core usage — <D19 message>`；只在 ≥80% 出现（与 D19 同条件），write 测试 ≥80% 出现/<80% 不出现两例                                                                 |
| C4  | ④ 写端口依赖从 wire 闭包传入          | ✅ 落实                 | `makeWritePort` 在 wire.ts:1951-1975：`entryIndex`/`taxonomyFor`/`dirFor` 均闭包；`createJevWritePort` 仅作工厂注入；另做 off(pi-api) 三方法口径收窄（缺 getModelOfType ⇒ 写路径零调用，有测试）+ afterWrite 后 `invalidate` 清 2s 语料缓存（新标签对下一次 A 层/门禁立即可见） |

### D. 安全性复检（实测，非推测）

用 tsx 直接驱动 `parseShell`+`matchTags`+`mergeTaxonomy` 实测 30+ 变体：

- **命中门禁**：`git commit`、`git -C . commit`、`/usr/bin/git commit`、`sh -c "git commit"`、`zsh -c '…'`、`bash --login -c '…'`、`env X=1 git commit`、`/usr/bin/env git commit`、`cd x && git commit`、`timeout 60 git commit`、`sudo git commit`、`nohup`/`nice`/`command`/`exec` 包装、`GIT_EDITOR=true`/`GIT_DIR=` 前缀、`(git commit)` 子 shell、`$(git commit)` 命令替换、`git -c k=v commit`、`--git-dir=`、`g\it comm\it`（反斜杠转义折叠）、tab/多空格、`--message=`、引号内多行、`git commit | tee`、`git commit && git push`（双标签）。
- **正确不命中**：`echo "git commit"`、`grep "git push"`（program 是 echo/grep）；`git\ncommit`（换行=两条独立命令，实际不构成 commit）。
- **可达绕过（J1 边界，非 J7 缺陷）**：`bash -lc 'git commit'` 不命中——shell-parse.ts:404-410 用 `argv.indexOf("-c")` 精确匹配，不识别 `-lc`/`-ic` 合并旗标（`bash --login -c` 同语义可命中）。复现：`bash -lc 'git commit -m x'` 经粗筛第 3 步同步放行。归 J1 shell-parse 能力边界，建议 J1 维护时把含 c 的短旗组组合归一化。
- **J1 自陈盲区（fail-open by design，文件头第 13 行）**：eval、ssh、xargs、find -exec、watch、脚本内命令（`make release-commit`/`npm run release-commit`）；git 本地别名（`git ci`）需用户 git config，agent 无法猜测，属设计边界。
- **只读集合无误列**：read/grep/find/ls/web_search/get_run_result/Task*（+`/^todo/i`，本仓 todo 组注册名 TaskCreate 等）/memory view|search——全部只读或仅写 todo 状态，无一能执行命令；bash/edit/write/Agent 等均不在集合、继续走后续步骤。
- **嵌套 executeTool**：`<parent>/1` id 与顶层同样被拦（memory-jev-gate.test.ts:230-236，C-J11）。
- **handler 异常放行**：fail-open 是 arch §6.4.5/C-J2 的设计要求（抛错的 handler 会阻断工具），非缺陷；构造输入触发异常即放行属已知取舍。

### E. J2 修复（510a0678）后的语义确认

- 修复内容已核实：单档超时置 `timedOut` 后 abort ⇒ 返回 `transient`（计熔断、failover 下一档）；只有外层 signal abort 才返回 `aborted`（client.ts:276-313 + 两个新测试）。
- **「Jev 未判定 ⇒ 证据档」在新语义下仍正确**：真超时由 wire 层 `withTimeout(all, budgetMs)` 捕获 ⇒ `controller.abort()` ⇒ `why:"timeout"`；两档都耗尽 ⇒ client 返回 `all-failed` ⇒ `why:"all-failed"` ⇒ 证据档；漏答 ⇒ `missing`；partial/无 registry ⇒ `partial`。四种形态均有测试（含 fake-clock 超时与 release-guard 实钟 hang 版）。wire.ts:1370 的 `o.reason==="timeout"` 与 `aborted&&!signal.aborted` 分支现均为死代码（client 顶层不产出这两个组合），无害、方向正确。

### F. 报告自陈 7 条遗留逐条判断

1. J2 client 问题 → 已由主会话修复（上文 E）；J7 的映射兼容新旧语义。**已解决**。
2. `hasPathLikeWord` 宽松多跑一次有界 git（≤1s、64KB cap、在 1.5s 证据预算内、仅粗筛命中后）→ **可接受**。
3. 粗筛同步 IO 读语料（2s 缓存）vs arch「零 IO」→ 有意近似，语料小、只读工具在 corpusFor 前已放行，实测毫秒级 → **可接受**（见 nit）。
4. core 用量再跑一遍 doctor → session_start 一次性、有去重 → **可接受**（见 nit）。
5. secret 条目不参与门禁 → arch §7.2「永不外发」的安全要求本身 → **正确行为**。
6. 进程/bash job 按命令行去重 → `seenCommands` 防重复条目，running≤10 → **合理**。
7. 未跑全量测试 → 指定组合已由本验收全绿；全量归主会话整合验证 → **可接受**。

### G. I1/I4/I5

| 项                 | 结论 | 证据                                                                                                                                                                             |
| ------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 计时器 unref       | ✅   | probes.ts:260-263、wire.ts:337-343（withTimeout）与 wire.ts:476-481（segmented clock set）全部 `unref?.()`；`grep setTimeout/setInterval` 共 3 处全核                            |
| 时长经 clampSpanMs | ✅   | 两个 withTimeout 首行 `clampSpanMs(ms)`；GATE_WAIT_MS=2500 作为 deadline 经 withTimeout                                                                                          |
| scanProc 缓存      | ✅   | 闭包实例 `createProcCache()` 由 wire closure 持有（I4 天然满足，非进程级故无需 `Symbol.for`）；verdicts/procCache/gateLocks/gitRunner 全部闭包内；probes.ts 模块级仅常量与纯函数 |
| Symbol.for         | —    | 两文件均无使用（正确：无进程级共享状态）                                                                                                                                         |

### H. /proc 基准（plan 风险项，只记录）

本机实测：真实 /proc 冷扫描 15ms、缓存命中 0ms（报告自陈 9.9-14.5ms/0.07ms，一致）。

## 验证命令执行记录

- `timeout 900 npx vitest run tests/memory …(用户指定全套 10 组)` → 退出码 0：**Test Files 82 passed (82) / Tests 1629 passed | 1 skipped (1630)**，12.38s
- `npx vitest run tests/integration/memory-jev-release-guard.test.ts` ×2 → 均 2 passed（稳定）
- `npx vitest run tests/integration/memory-jev-gate.test.ts` ×2 → 均 5 passed（稳定）
- `timeout 600 npm run typecheck` → 退出码 0（tsc ×2 + vue-tsc）
- `npx prettier --check <J7 全部 11 个文件>` → All matched files use Prettier code style!；全仓 `npm run format:check` → 退出码 0
- `git diff HEAD -- tests/fixtures/` → 0 行；`git log origin/dev..HEAD -- tests/fixtures/` → 仅 J0/J5/J6 三个提交
- `npx tsx` 驱动 parseShell/matchTags 实测 30+ 命令变体（输出见 D 节）
- `npx tsx` 实测真实 /proc 扫描耗时（冷 15ms / 热 0ms）

## 发现的问题

- **minor（J1 边界，不阻断 J7）**：`bash -lc '<高危命令>'` 可绕过粗筛（shell-parse.ts:407 的 `argv.indexOf("-c")` 不识别 `-lc` 合并旗标）。建议在 J1 后续维护中修复：解释器短旗标组合（`-lc`、`-ic`、`-xc` 等含 c 者）应视同 `-c` 取其后脚本串递归解析。
- **nit**：wire.ts:1370 两个防御分支为死代码（J2 修复后 client 顶层不产出 `timeout` reason；bare `aborted` 不可达），无害。
- **nit**：粗筛冷缓存同步 IO、core 用量重跑 doctor —— 报告已自陈，影响有界，可接受。

无阻断项：J7 通过验收，建议随后 commit（J1 的 `-lc` 旗标问题单独立项转 J1 维护）。","verdict":"pass"}
