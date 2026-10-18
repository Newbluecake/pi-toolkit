# Package C — follow-up threads + warm/cold prediction + lifecycle

日期：2026-10-18。状态：实现与自验通过；**未提交 commit**。依据 `cache-thread-plan.md` v2（§4 全部、§5.1、§7、§8、§11 的 C 测试）+ 用户裁定（可选 `fresh`、追问预检保守按冷写）+ §R1/§R2（R2-1 seal 证明、R2-2 线程世代栅栏、R2-3 磁盘预算与采纳前复查、R2-4 consult 自身 diag 的 `consultThread`）。方案作者（r_26AM5048）就 4 个接缝问题做了裁定（见 §8）。

## 1. 线程状态机（`src/consult/threads.ts`，pi-free，闭包状态）

键 = `askerRunId × expertRunId`（`"main"` 不建线程：工具层 `isMain ⇒ threads === undefined`）。记录：`id, gen, closed, head?, candidate?, base?, snapDigest?, sourceKey?, seq(=已晋升次数), busy?, lastUsedAt`。

`begin()` 决策（同步，一次调用产出一个 `ThreadLease`）：

| 条件（按判定顺序）                                                             | mode        | 来源文件       | keep  | 备注                                                         |
| ------------------------------------------------------------------------------ | ----------- | -------------- | ----- | ------------------------------------------------------------ |
| registry 已 close                                                              | —           | 返回 undefined | —     | 工具走旧路径（无首行、无线程）                               |
| `fresh:true`                                                                   | `fresh`     | 原 session     | true  | 旧线程 gen+1、删 head；新线程 id，本次是它的 #1              |
| 线程 `busy`（同线程已有保留型 consult 在飞）                                   | `branch`    | head（或原）   | false | 单写者；`retained=head.seq`，绝不晋升                        |
| 原 session 签名（size:mtime）变了 / head 文件消失                              | `reset`     | 原 session     | false | reason `identity`                                            |
| 晋升次数 ≥ 8 / head > 64 MiB / `headGuard`：上下文≥75% 或冷写估算 > 首请求上限 | `reset`     | 原 session     | false | reason `seq-cap` / `size` / `context` / `cost`；旧线程整个关 |
| 无法再容纳一份拷贝（含在途；先淘汰最久未用的空闲 head 仍不够）                 | `reset`     | 原 session     | false | reason `budget`                                              |
| 原 session > 64 MiB                                                            | `reset`     | 原 session     | false | reason `size`，无线程记录（游离一次性租约）                  |
| 有未决 candidate（上一答案尚未 seal 晋升）                                     | `pending`   | head（或原）   | false | 绝不复制未 seal 文件                                         |
| 有 head                                                                        | `continued` | head           | true  | `seq = retained+1`；`base` 仅来自首次晋升                    |
| 其它                                                                           | `new`       | 原 session     | true  |                                                              |

> 偏差说明（照抄方案 §4.2②）：**reset 的结果本身不保留**（keep=false）；reset 之后线程记录为空，下一问是 `new`。`fresh` 例外（它的结果是新线程 #1）。

生命周期事件：`openFork`（复制成功后、spawn 前登记 rec，保留型登记为 `candidate`）→ `settle`（工具拿到 outcome：eligible = completed ∧ 文本非空 ∧ 守卫未终止 ∧ 无 `[consult-preserve:` 失败 ∧ keep）→ `onReaped(path,{disposed})`（runner 的物理回收）。**晋升 = eligible ∧ sealed(disposed:true) ∧ epoch 相同 ∧ 线程未关 ∧ `rec.gen === thread.gen` ∧ 仍是该线程 candidate ∧ 复核大小/预算通过**；两件事谁后到都触发。晋升后删除旧 head、`seq+=1`、`base` 只在首次晋升写入且永不更新。

`onReaped` 的裁决（`keep|delete`）：retained head 永不删（重复回调也不删）；未知路径 `delete`（旧行为）；`info?.disposed !== true`（缺省 / reaper 返回 false / reap reject / unkillable / adapter 早退无第 4 参）⇒ **一律删除、永不采纳**（R2-1）；已 seal 但工具尚未判定 ⇒ `keep` 等 `settle`；工具异常路径由 `finally` 里 `settle(path,{eligible:false})` 兜底，不留悬空 candidate。

## 2. 栅栏（R2-2 / §4.3）

- 每线程 `gen`。**asker 终态**（`dispatchSnapshot` 看到任一终态快照 ⇒ `onRunTerminal`）、FIFO/LRU 淘汰、reset、`fresh`、`close()` 都 `gen+1` 且 `closed=true`、从 map 摘除、立即删 head；已 reaped 的 candidate 立即删，未 reaped 的留给自己的 `onReaped`（永远不在 session 消失前删）。
- candidate 记下开始时的 `gen`/`epoch`；`resolve()` 任何一项不等 ⇒ 只删自己文件，**不复活线程**。
- epoch = 每个 `wireConsult` 实例一个 id；旧闭包 `close()` 后，迟到的 settle/onReaped 全部只会 delete。已测：6 种 settle/reap/terminal 排列、fresh/evict 与迟到结果交错、close 后迟到回调、两个 registry 互不干扰。

## 3. 磁盘与回收（R2-3 / §4.4）

- 复制前 `fs.size(source)`：>64 MiB ⇒ reset(size)（原 session 过大时不建线程记录）。
- 预算 512 MiB = Σ head + **所有自有 fork**（含仍在追加的：每次按 `max(预留, 现 stat)` 重新核算）+ 尚未复制的租约预留。超出时按 `lastUsedAt` 淘汰**空闲**（非 busy、无 candidate）线程的 head；仍不够 ⇒ reset(budget)（不拒绝 consult）。
- **晋升前重新 stat 真实大小**：`actual > 64 MiB` 或 `makeRoom(actual − 旧head)` 失败 ⇒ 不采纳、删文件、保留旧 head、`stats().refusedAdoptions += 1`（R2-3 的 `fallback:"size"`）。
- 上限：32 线程、每线程 8 次晋升（之后 reset seq-cap）。
- 软 TTL 60 min、**惰性**检查点：consult 入口（`begin`）、任一终态快照（`onRunTerminal` 的 `sweepIdle`）、`close()`。无任何事件时 head 可能活过 60 min，最长到 asker 终态 / 栈关闭 / 下一次 build 的 24h `sweepForkDir`。**没有新增 timer**。

## 4. tool result 首行（§4.5，六种；仅 completed / partial 答案带，失败/拒绝不带）

```
[consult thread <id> #n — the expert sees your previous n−1 question(s) and its full answers]   // continued
[new consult thread — no earlier Q/A with this expert]                                           // new
[fresh consult (fresh:true) — earlier Q/A in this thread were dropped and will not be retained]  // fresh
[thread reset (<reason>) — the expert does NOT see your earlier questions]                       // reset: context|cost|size|budget|seq-cap|identity
[previous answer not yet retained — the expert sees up to #m only]                                // pending
[parallel branch — the expert sees thread #m; this answer will NOT be kept for follow-ups]        // branch
```

偏差：branch 且 `m=0`（线程还没有任何已保留答案）时用 `[parallel branch — the expert sees no earlier Q/A in this thread; …]`，避免出现「thread #0」。首行后空一行再接答案。截断提示按保留状态二选一（eligible ⇒ `it will be kept in this consult thread once this consult closes …`；否则 `this answer is not retained — ask a narrower follow-up.`）；partial 答案沿用旧提示。没有 `deps.threads`（旧 deps）时整个结果字节不变（无首行、旧截断提示）。

prompt：`buildConsultPrompt({followUp:n})` 在 R2 头部之后、`\nQuestion:\n` 之前插入一行 `This is follow-up #n …`（n≥2；head 来源的 continued/pending/branch 都是 `retained+1`）。`READ-ONLY CONSULT MODE\n` 前缀与 `\nQuestion:\n` 标记不变，d2 解析器用真实 `consultTranscript` 测试钉住。

## 5. 守卫与上下文（§4.6/§4.7）

- 原 session 的 75% 上下文 / 首请求成本预检**原样保留**（先于任何租约，nack 不会泄漏租约）。
- 有 head 时 `headGuard`：`head.percent`（或 `head.tokens / contextWindow`）≥75% ⇒ reset(context)；**追问预检保守按冷写** `head.tokens × max(input, write)` > `maxFirstRequestUsd` ⇒ reset(cost)（用户裁定）。head 来源的 consult 的 `costEstimateUsd/turnBudgetHint/budgetNote` 改用 head 估算。每次 consult 的 `maxTurns/maxCostUsd` 不变。
- 续问对新 fork 重新 `scanExpertSnapshot`（快照、R2 清单、shadow 工具原样复用，不放宽）。若 head 的 loadout `snapDigest` 与线程首个不一致 ⇒ 删这份拷贝、`forceReset:"identity"` 重来一轮（最多 2 轮），绝不在不同前缀上续问。守卫计数仍按 run 计；`blocked_cap` 不 eligible。

## 6. 预判与账本（`src/consult/anchor-ledger.ts`，§5.1 + 作者裁定）

- 只记**被证实的触达**：真实请求带 `added|relocated` 锚点、`!degraded`、响应 `cacheRead+cacheWrite ≥ 0.9×baseLB`（`baseLB` = 快照 `lastRequestUsage` 三项和）；时刻 = 请求**开始**（`first.startedAt`，不是 `diag.consultCache.first.at`）。**B 的接缝**：优先 `firstSuccessful`；`first.responseOk===false` 且无 `firstSuccessful` ⇒ 无证据；`first.anchorIdentityValid===false` ⇒ 当作锚点缺席（不进账本、不当线程 base、`cacheResult` 为 n/a/用成功请求）。
- key = `expertRunId + route(provider/model) + snapDigest`；`snapDigest = sha256(tools, systemSections, cwd, 专家原 session 的 size:mtime)`，所以**跨 asker 的首次 consult** 也能命中同专家的触达（作者裁定：cross-asker `warm` 是预期行为）。
- 谓词：`warm` = 匹配条目 ∧ 非 degraded ∧ `now < touch + 5min − 15s`；`cold` = 匹配条目且 `now ≥ touch + TTLcold`（5 min，若触达请求带 `ttl:"1h"` 则 60 min，仅放宽 cold 阈值，**不声称 1h 存活**），或本进程无该专家条目且 `settledAt + 5min ≤ now`；`unknown` reasons：`main | non-anthropic | no-snapshot | oauth-limit | degraded-anchor | digest-mismatch | ttl-margin | no-evidence`。FIFO 256 条。
- **每个 consult run 都写 `predicted`**（A 的交接要求）：经 `consultDisplayMeta`（take-once，key = fork 路径）在 enqueue 时折进 consult run 自己的 `diag.consultCache.predicted`；main / 无账本 / OAuth 降级 ⇒ `{state:"unknown", reason}`，有测试。
- **一份事实，两处投影**：`lease.{threadId,seq}` 同时写入 consult run 自己的 `diag.consultThread` 与 asker 探针 `cacheProbes[].thread.{id,seq,mode,reason}`；`predicted` 同时写入 `diag.consultCache.predicted` 与探针 `warm`（测试逐字段相等）。探针另带 `anchor{state,ttl?,degraded?}` 与 `cacheResult`（A 的 `classifyConsultCacheResult`，首个**成功**请求用量）。

## 7. 生命周期（§7）

`ConsultWiring.close()`（幂等，不抛，无 timer）：关 threads（删全部 head 与已 reaped 候选）、清账本与待取 meta。三条路径：① `session_shutdown`（`src/index.ts`，在 `stack.keepalive?.dispose()` 之后、drain 之前；`/reload` 先发 reason `reload` 的 shutdown）；② `session_start` 开头的防御性清理（`holder.current.consult.close()`）；③ `buildSessionStack` 顶部 `previousConsult?.close()`（在本次 build 的 `sweepForkDir` 之前）。`tests/integration/consult-reload-dispose.test.ts`（9 例）：三条路径各自删 head/清账本/关闭；迟到 `onReaped` 只删不晋升；`vi.resetModules()` 得到全新模块实例（等价 jiti `moduleCache:false`）后旧激活的 shutdown 仍清干净、新栈为空；另有真实 pi `loadExtensions`（jiti）两次加载的冒烟。**披露**：真实 jiti 例只证明加载/handler 注册——线程闭包不对外暴露，其行为断言用 vi.mock 捕获 `wireConsult` 实例 + `resetModules`，不是 jiti 里的断言。

## 8. 与方案作者的裁定（r_26AM5048）

1. **Q1 meta 投递**：采用 (d)，key 是 `forkSessionFrom`（不是 label）；新 optional dep `consultDisplayMeta?(forkPath)`，take-once，工具 `finally`（及 spawn 失败路径）`drop`。
2. **Q2 base**：`anchorOf` 接缝（默认读 prefix registry）；仅 `added|relocated` 且有 identity 且非 degraded 才设 base；首次晋升写入、永不更新；reset/fresh 连同 base 一起丢。无 base 的追问预测 `unknown(degraded-anchor)`。
3. **Q3 预判谓词**：见 §6。
4. **Q4 seal**：`RunnerDeps.onReaped` 第 4 参 `info?: {disposed:boolean}`；late-arrival（`disposeLate` 之后）⇒ true；主 reap 点 ⇒ `reaped?.disposed===true && unkillable.length===0`；adapter 早退无第 4 参 ⇒ 未 seal ⇒ 删文件。

## 9. `runtime-adapter.ts` 里属于 C 的 hunk（B 持有该文件；B 已确认保留）

仅这 4 处（`git diff src/service/runtime-adapter.ts` 的其余 hunk 都是 B 的 `consultAnchor` 透传）：

1. `import type { … }` 增加 `ConsultCacheDiagnostics`、`ConsultThreadRef`。
2. `RuntimeAdapterDeps.onReaped` 类型加第 4 参 `info?: { disposed: boolean }`。
3. 新 optional dep `consultDisplayMeta?(forkSessionFrom) => { consultCache?, consultThread? } | undefined`（紧跟 `onReaped` 文档块之后）。
4. 构造 `ResolvedSpawnRequest` 前一次性取 `consultMeta`（仅 `isConsultRun && forkSessionFrom !== undefined`），并在 `displayMeta` 的 `consultOf` 之后 spread `consultCache` / `consultThread`。

其它 C 侧改动（`runner.ts` 第 4 参 + 三个调用点；`stack.ts`：`previousConsult` 模块变量 + 顶部 close、`consultDisplayMeta`/`onReaped(…, info)`/`routeApi` 接线；`index.ts`：两处 `consult.close()`）。

## 10. 交付文件（绝对路径）

源码：`/home/bluecake/ai/pi-toolkit/src/consult/threads.ts`（新）、`…/src/consult/anchor-ledger.ts`（新）、`…/src/consult/tool.ts`、`…/src/consult/index.ts`、`…/src/consult/prompt.ts`、`…/src/stack.ts`、`…/src/index.ts`、`…/src/runtime/runner.ts`、`…/src/service/runtime-adapter.ts`（§9 的 4 处）。`src/consult/fork-store.ts` **未改**（线程大小检查走 `ThreadFsPort`，删除走既有 `removeForkFile`）。

测试：`tests/consult/threads.test.ts`（新，31 例）、`tests/consult/anchor-ledger.test.ts`（新，10 例）、`tests/consult/consult-tool.test.ts`（schema 断言更新 + 17 例线程/预判/账本/B 接缝）、`tests/consult/prompt.test.ts`、`tests/consult/fork-store.test.ts`（head 链）、`tests/integration/consult-reload-dispose.test.ts`（新，9 例）、`tests/integration/consult.test.ts`（并发例按新首行/保留 head 更新 + 新增生产链追问例）、`tests/runtime/runner-reaped-disposed.test.ts`（新，7 例，R2-1）。报告：本文件。

## 11. 自验

```
$ timeout 280 npm run typecheck           → EXIT 0   (/tmp/consult-C-typecheck.log)
$ timeout 900 npx vitest run tests/consult tests/integration/consult-reload-dispose.test.ts \
    tests/integration/consult.test.ts tests/integration/consult-wiring.test.ts tests/service tests/core tests/runtime
  Test Files 108 passed (108) · Tests 1999 passed (1999)   (/tmp/consult-C-vitest.log)
$ timeout 280 npx vitest run tests/integration tests/conformance/consult-preserve.test.ts --reporter=dot
  Test Files 97 passed (97) · Tests 676 passed | 3 skipped
$ timeout 280 npm run build               → EXIT 0
$ npx prettier --check <本包全部源码与测试>   → All matched files use Prettier code style!
```

## 12. 交接

- **U**：展示事实全部在 consult run 自己的 diag：`diag.consultThread = {threadId, seq}`（分组与 `t#n`）、`diag.consultCache.predicted`（enqueue 写入，所有 consult run 必有）+ B 发的 `first`。asker 探针 `cacheProbes[].thread.{id,seq,mode,reason?}` 与 `warm` 与之同源。`mode` 的取值即 §4 六种；`reason` 仅 reset。head 晋升会删除旧 head：consult-1 的 `diag.sessionFile` 此后不存在，d2/UI 不得假定文件存在。预判 `unknown` 的 reason 见 §6，`ttl-margin` 是 C 额外的原因串。
- **F**：线程键 `cacheProbes[].thread.id`（run 自身 `consultThread.threadId`）；`seq` 是该答案被问到的位置（保留型 = 晋升后的 seq；branch/pending/reset 的 seq 是「它看到的已保留答案数+1」，不会被保留）；`cacheResult` 取自首个成功请求。`warm.state/evidence` 是开始时的预判，不被首响应覆盖。
- **E1**（生产链 conformance，R2-5）：C12 可以直接沿用 `tests/integration/consult.test.ts` 的新例的搭法（真实 `buildSessionStack` + 真实 fork-store + 真实 runner，仅驱动器是 fake）；真实 pi + Anthropic 桩下需要核实三件我无法在此验证的事实：(a) consult run 的 session 文件**不会追加新的 system/tool 声明**，否则 head 的 `snapDigest` 会漂移，线程会被 `identity` reset（安全但等于线程失效——这是本包最大的未验证假设）；(b) head 文件在 fork 之后包含 `H + Q1 + A1` 且 A1 完整（超过 `maxAnswerChars` 的原文仍在）；(c) 追问第 2 问的 messages = 第 1 问 messages + A1 + Q2。

## 13. 已知遗留 / 不在本包范围

- OAuth 4 断点 / M4：账本只认 `degraded` 标志；`oauth-limit` 原因需要一个路线级 OAuth 信号，目前 stack 不提供（`PredictQuery.oauth` 已留，测试覆盖）。
- Phase 2（保活、`usage_accrued`、sink 注册表）未实现，`close()` 里没有 keeper 钩子；Phase 2 在 `close()` 里追加即可。
- `consult.keepalive` 等设置未新增；`AGENTS.md` 的 consult 段由 G 包更新。
- 并行改动的 feishu 文件曾出现过瞬时类型错误（非本包），最终 typecheck 全绿。

## Verification (r_38A7HG4K, GLM — pass, 0 blockers)

The open risk (§12 a/b/c) was resolved by the verifier with real pi 1.2.0 + the Anthropic stub: a consult run appends only user/assistant entries, the loadout digest of fork/head/next fork is identical, and the follow-up's first request is the head prefix + A1 + Q2 — threads continue in practice (production-chain conformance with C2 guard/shadows/B anchor remains E1's job). Follow-ups queued as a separate package: branch consults bypass the head cost/context guard (minor), disposeLate hard-codes `disposed:true` (minor), plus nits 3–6 of the verification report.
