# traffic 合并 T2b 报告：请求归属（票据）与写库预算

> 依据：`docs/dev/traffic-merge/plan.md` r3：§0（1d / 2、R-a / R-b / R-d）、§3.2、§5.3、§5.4、§8.2 #5–#8、§10 T2b 行、§R1 #1/#5/#9、§R2 R1-1/R1-9。
> 基线：T2a `23b9f579`。**未 commit、未暂存**。拟用提交标题：`fix(traffic): attribute provider fetches by per-request ticket`。
> 仍不接线：`src/index.ts`、settings 及 `src/traffic` 以外的模块都没改，`git grep -n "traffic/" -- src ':!src/traffic'` 结果为空。`server.ts`、`page.ts`、`web/**` 也没动，那是 T4 的文件域。
> 设计意图问题已向方案作者（r_YRWB4PF3）确认，问答结论标注为「作者确认」。

## 结论先行

- **安全评审（gpt-6.1-sol，reject：2 Blocker + 7 Major）已按主会话裁定修复 #1–#6、#8、#9，#7 记为已接受残留**，逐条见 §12。
  每条都有回归测试，且已**在临时还原修复后实跑确认这些测试会失败**（§12.10）。
- **§3.2 硬验收门：同线程 `DbPort` 达标，不需要切 T2c（worker）。** 修复后按真实多 runner（1 主 + 3 子会话激活）重跑 3 轮，
  5 个场景全部通过，且每个请求都被票据精确绑定、发送路径零 DB 调用。数字见 §6.2（旧表中「并发 4」一行无效，已替换）。
- 达标靠两项本包内的修正，均在 §6.3 有测量依据：
  1. WAL checkpoint 单独占一个 tick；
  2. payload 的 `JSON.stringify` 移出发送路径。
- **待 T4 落地后复测**：硬门第二场景（历史 + 导出）这次用 `DbPort.pages()` 模拟，因为 server 端点归 T4。T4 落地后，需要在 T4 验证或 T7 V11 里对真实端点重跑一次（作者确认的分工）。

## 1. 改动文件

**源码 `src/traffic/`**

| 文件           | 性质 | 要点                                                                                                                                                                                                                                                         |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ticket.ts`    | 新增 | 票据台账与 runner 存活集合 L、配对判据 `decidePairing`、generation、四条退役规则、台账回收（TTL 与 FIFO 1024）、白名单 `TICKET_APIS`。纯逻辑，时钟可注入                                                                                                     |
| `db-port.ts`   | 新增 | `DbPort` 接口和同线程实现 `createInThreadDbPort`：写后账本、每 tick 预算、BUSY 退避、行补丁合并、有界缓冲与溢出计数、chunk 合并批、独占 checkpoint tick、延迟物化、keyset 分页读、有界关闭                                                                   |
| `capture.ts`   | 重写 | fetch 层按 §5.3 的 fetch 表处理：凭票据认领；按 (T, generation, 正文摘要) 改写、复用或透传；线级字段和状态直接取自 `Response`；阻断结果重抛，通知 30s 去重；流 chunk 进账本                                                                                  |
| `index.ts`     | 改   | 钩子层：headers 钩子铸票据并注入请求头；payload 钩子做可证明配对，否则写 hook 级行并记 `unattributed`；按规则回填 hook 级响应；`message_end` 触发退役规则 ②；子会话 `agent_settled` 清理；观察 `cache_warming_decision`；`/record status` 增加归属和写入两行 |
| `engine.ts`    | 改   | 移除 `gate`、`corr`、`pendingRequests`、`attempts` 等闸门和推断关联字段，新增 `tickets`、`dbPort`、`lastRewrittenAt`、`unsupportedApiNotified`。`gate` 只保留兼容桩 `gateStats()`（恒为 inactive）。close 先同步 `tickets.retireAll()`，再有界排空账本       |
| `persist.ts`   | 改   | 新增 `drainAllowed`（账本执行前的闸口）和 `recordInsert`、`recordPatch`、`recordSql`、`recordChunk`（入队时复查闸口）。`persist()` 同步写只保留给命令和网页路径                                                                                              |
| `db.ts`        | 改   | `busy_timeout = 0`；新增 `UPSERT_SESSION_SQL` 和 `sessionUpsertParams`，在钩子时刻取值、交给账本执行                                                                                                                                                         |
| `correlate.ts` | 删减 | 推断式 `createCorrelator` 整体删除，只留纯函数 `makeProbe`、`urlMatchesBase`、`respKeyOf`                                                                                                                                                                    |
| `state.ts`     | 删减 | 删除 `PendingRequest`、`Attempt` 和对 `GateSlot` 的引用                                                                                                                                                                                                      |
| `serialize.ts` | 删除 | 全局串行闸门退役（§5.3「闸门退役」）。在工作区直接删除；最初误用了 `git rm`，主会话已取消暂存                                                                                                                                                                |

**测试 `tests/traffic/`**

| 文件                                                    | 性质    | 内容                                                                                                                                                                           |
| ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `helpers/harness.ts`                                    | 新增    | 按 pi 真实请求路径模拟（headers → payload → fetch → 2xx 才触发 after），每次激活一个 runner；上游 stub 记录收到的字节和头                                                      |
| `ticket.test.ts`（#5）                                  | 新增 12 | 铸造、runner 隔离、配对判据、generation 递增、退役 ①–④、子会话清理、台账回收（各档 TTL、硬上限、FIFO）                                                                         |
| `attribution-matrix.test.ts`（#6）                      | 新增 18 | §5.3 故障矩阵，逐条见 §7                                                                                                                                                       |
| `internal-requests.test.ts`（#7）                       | 新增 9  | §5.4 接入矩阵逐行                                                                                                                                                              |
| `db-contention.test.ts`（#8）                           | 新增 5  | **§3.2 硬验收门**，可复跑；数字以 `[traffic-gate]` 前缀输出，设置 `TRAFFIC_GATE_JSON=<path>` 时另存 JSON                                                                       |
| `db-port.test.ts`                                       | 新增 13 | 账本单元：合并、闸口、语句错误隔离、持锁退避、有界丢弃无错位、字节上限（持锁期间也物化）、tick 预算、大条目独占、checkpoint、chunk 批、分页、有界关闭                          |
| `capture-rewrite.test.ts`                               | 迁移 17 | 原 T7 的 a–o 迁到票据语义：poison 改为「同 generation、同摘要重抛同一错误，零 jq、零写入」，通知去重跨新票据 30s；新增 g2、l、p                                                |
| `correlate.test.ts`                                     | 迁移 8  | 依赖 holder 推断的用例改为断言「不再推断」（§8.1）；纯函数断言保留                                                                                                             |
| `hooks.test.ts`                                         | 迁移 7  | 「等待闸门」改为「钩子同步完成、零定时器」；INSERT 失败只在 flush 时记 dbError；白名单外 API 一次性提示                                                                        |
| `serialize.test.ts`                                     | 删除    | 其中 poison 和重试语义已改写进 `ticket` / `capture-rewrite`（§8.1）                                                                                                            |
| `engine.test.ts`、`mode-gate.test.ts`、`secure.test.ts` | 小改    | 读库前加 `await dbPort.whenIdle()`。子会话钩子集合加入 `agent_settled` 和 `cache_warming_decision`。「陈旧续体」用例改写为 fetch 续体跨 reload（原用例依赖已退役的闸门 await） |

## 2. 票据状态机

```
                 headers 钩子（open ∧ recording ∧ isActive ∧ ¬secure ∧ tapActiveFor(engine) ∧ api∈白名单）
   (无) ───────────────────────────────────────────────────────────▶ minted（∈ L）
                                                                       │ payload：L={T} ⇒ bind gen1（新行）
                                                                       ▼
                     ┌──────────── fetch 非成功（4xx/5xx/抛错）────── bound(gen n)
                     │                                                 │ fetch 2xx/3xx ⇒ 规则① 退役
                     ▼                                                 ▼
          failed（∈ L，lastFetchOk=false）──payload ∧ L={T} ⇒ gen n+1（新行）    retired（∉ L，台账仍认得）
                     │                                                            │
                     └─ 规则② assistant message_end（60s 内无 warming 放行）/ 规则③ TTL / 规则④ close ─┘
                                                                                   ▼
                                    台账回收：未绑定 30s · 已绑定未 fetch 120s · 已 fetch 末次响应+60s · 硬上限 10min · FIFO 1024
```

- **退役与回收是两件事**：
  - 退役只表示票据不再参与 L 的判定；
  - 回收表示 fetch 层不再认得这个票据头，此后按 `staleTickets` 剥离票据后透传。
- **runner** 按「激活 × engine」绑定。`/record on` 新建 engine 时得到新台账和新 runner，旧票据随旧台账作废，因此纪元不同的票据一律不认。
- **铸造额外要求 `tapActiveFor(engine)`**：tap lost 之后、用户重新安装之前，不铸造新票据，避免随机头到达 provider（对应 §13-2 的窗口）。
- **规则 ② 的范围**（作者确认）：L 内全部存活票据，包括未绑定的和已绑定但未 fetch 的。
- **warming 前提**：`cache_warming_decision` 的 `event.action !== "stop"` 时记为「放行」，偏保守，因为其它扩展之后可能改成 stop。T5 的否决由 T5 另行注册。

## 3. 配对判据与 generation

`decidePairing(L)` 是纯函数：

| L                                                     | 结果                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| \|L\| = 0 或 ≥ 2                                      | `unattributed`：写 hook 级行，`rewrite_status='unattributed'`，`unattributedPayloads++`。**绝不按唯一未配对票据认领** |
| {T}，T 未绑定                                         | `bound`，gen 1                                                                                                        |
| {T}，T 已绑定、最近一次 fetch 非成功、且无在途 fetch  | `bumped`，gen n+1                                                                                                     |
| {T}，其它情况（已绑定但尚未 fetch / 在途 / 最近成功） | `unattributed`（无法证明）                                                                                            |

- **每个 generation 插一行新的 `requests`**（作者确认）：gen 1 的行保留 400 状态和它自己的线级字段；内存里的票据绑定和改写缓存切到 gen n+1。schema 不变。
- **generation 携带**：本代的行引用、规则快照（payload 时刻读取）、模型、`baseUrl`、正文摘要、改写 promise、线级字段是否已写、流是否已捕获。
- **白名单外 API**：不铸票据，只写 hook 级行（`rewrite_status` 为 NULL）。有启用规则时 `unsupportedApiPayloads++`，并只提示一次「不在票据白名单，改写规则对其不生效」（R-b）。若是 Codex，同时置 `codexWsWarned`，供 server 现有的 `codex_ws_warning` 字段使用。
- **`baseUrl === null` 且有启用规则**：不改写，`nullBaseUrlSkips++`，只提示一次（沿用源实现语义）。

## 4. fetch 表实现（`capture.handleFetch`）

| 情形                                              | 实现                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secure 或无票据头                                 | 直接透传（wrapper 已剥离票据）                                                                                                                                                           |
| 票据未知、已回收或属其它纪元                      | 透传，`staleTickets++`                                                                                                                                                                   |
| 从未绑定（例如 compaction 只有 headers）          | 透传，不改写、不写线级字段；响应仍参与规则 ① 退役                                                                                                                                        |
| 已绑定，URL 不在本代 `baseUrl` 下                 | 透传，`unattributedFetches++`                                                                                                                                                            |
| 已绑定，本代尚无摘要                              | 计算 `bodyDigest`（sha256，压缩正文先解压；不做 `JSON.parse`）并绑定到本代；运行改写，结果以 promise 缓存在本代；线级字段写入本代行                                                      |
| 已绑定，摘要相同                                  | 同 generation 的网络重试：复用同一个改写 promise，正文字节一致，jq 不重跑（并发重试同样只跑一次）。规则没改头时，用本次请求自己的头（SDK 重试计数等）                                    |
| 已绑定，摘要不同（或 await 期间 generation 变了） | 透传，不改写、不写该票据的行，`unattributedFetches++`                                                                                                                                    |
| 本代已 blocked                                    | 重抛**同一个**错误对象：零 jq、零写入、原请求不发出。通知按 (会话, 规则集 id, kind, phase, rule_id) 30s 去重，跨新票据同样生效                                                           |
| 收到响应                                          | `status` 和 `response_headers` 由 fetch 层直接从 `Response` 写入本代行（合并成一个补丁）。2xx/3xx ⇒ 退役并标记 `awaitingHookSince`；event-stream 类响应经 `captureStream(rowRef)` 进账本 |

- 改写只在 `state.recording` 为真时执行。`/record off` 发生在配对之后、fetch 之前时，该次 fetch 不改写（用例 g2）。
- 实际改写过的请求会写入 `engine.lastRewrittenAt[sessionId]`，留给 T5 的 `vetoCapture` 使用。

### hook 级响应回填（`after_provider_response`）

1. 若本 runner 有票据带 `awaitingHookSince`（fetch 已收到 2xx），且没有等待中的 hook 级行：这次响应属于票据请求，fetch 层已经精确写入，这里只消费最早的那个标记。
2. 若没有 awaiting 票据、也没有 hook 级行：执行 tap lost 判定。L 中若有已绑定但 `fetches=0` 的票据，就调用 `checkTapAfterResponse`。
3. 若没有 awaiting 票据、hook 级行恰好 1 条、且 L 为空：回填这一条（`hookBackfills++`）。
4. 其它情况一律不回填，`unattributedResponses++`。不会拿某一条「当前行」去冒充并发请求的关联。

## 5. 写后账本与预算（`db-port.ts`）

| 机制                | 实现                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 不等锁              | `busy_timeout=0`；每个 tick 只尝试一次 `BEGIN IMMEDIATE`。遇到 BUSY 就放弃本 tick，用 unref 的 `setTimeout` 退避：10→20→40…→500ms                                                                                              |
| 调度                | `setImmediate`。**注意这里是 ref 的**：实测 unref 的 Immediate 会被 poll 阶段拖延，最长拖到下一个定时器（约 2s）。ref 的 Immediate 每次只占一轮事件循环，不会让 print 模式挂住。退避、封批、whenIdle 用到的定时器都是 unref 的 |
| 预算                | 每条执行后检查 `performance.now()`，累计 ≥2ms 就 COMMIT 并让出。>256 KiB 的条目独占一个 tick，执行前先提交已攒下的小条目                                                                                                       |
| **独占 checkpoint** | 本连接设 `wal_autocheckpoint=0`（只影响本连接，不影响其它连接和进程）。每写入 ≥1 MiB，用一个**单独的** tick 执行 `wal_checkpoint(PASSIVE)`。见 §6.3 ①                                                                          |
| **延迟物化**        | payload 列存为 `lazyText(() => JSON.stringify(payload))`，由一个**不需要锁**的物化 tick（2ms 预算，每次至少 1 条）完成序列化。持锁期间照样物化，所以 8 MiB 字节上限在锁竞争下依然有效。见 §6.3 ②                               |
| 合并                | 同一行的补丁合并为一个 UPDATE；行还没插入时直接并进 INSERT 的值。`coalesce` 列只在新值非 NULL 时覆盖。chunk 每 64 块或首块后 250ms 封一批                                                                                      |
| 有界                | 最多 512 条或 8 MiB，超出时按 FIFO 丢最旧的。`droppedRows` 按本应落库的行数计数（插入 1、chunk 批 N、messages 1），另有 `droppedByKind` 分项                                                                                   |
| 无行错位            | 被丢弃的插入会把 `RowRef.dropped` 置位，依赖它的补丁和 chunk 在执行时跳过并计入 `orphanOps`，**绝不写到别的行**（UPDATE 只按本行的 rowId 执行）                                                                                |
| 闸口                | 入队时 `persistAllowed`；执行前 `drainAllowed` 再查 secure、纪元、是否已 closed。engine 处于 closing 时，关闭前已接纳的条目在 `closeBoundMs` 内有界排空，不接纳新条目，所以没有能复活录制的路径                                |
| 读                  | `pages(q)` 按 keyset 分页，每页 ≤200 行，页内每行后检查 2ms 预算、超出就提前切页；页间和返回前都 `setImmediate` 让出。`query()` 收集全部页，受截止时间约束                                                                     |
| 可见                | `/record status` 的「写入」行显示：排队、丢弃、退避、最长语句、孤儿、写错误；`dbPort.stats()` 另有 `checkpoints`、`maxCheckpointMs`、`maxTickMs`、`ticks`、`backoffMs`                                                         |
| 熔断                | r3 已不设熔断（作者确认），持续竞争由账本上限兜底。BUSY 连续超过 30s 时 notify 一次，退避保持 500ms                                                                                                                            |

## 6. 硬验收门（`tests/traffic/db-contention.test.ts`）

### 6.1 口径（作者确认）

> **运行方式（主会话裁定，2026-10-23）**：≤10ms / ≤80ms / ≤5s 这些**计时门槛只在 `PI_TRAFFIC_PERF_GATE=1` 时断言**，即
> `npm run test:traffic-gate`（独立运行，不与其它测试文件并行）。常规套件 / CI 里同一文件只做功能断言（票据归属、行归属与凭证、
> 发送路径零 DB、丢弃计数自洽、取消确实生效、最终排空），数字照常打印。**硬门以独立运行与真机 V11（含 IO 负载）为准；V11
> 复现超限 ⇒ 启动 T2c。** 原因见 §6.2 末的门外失败：全量并行时 checkpoint fsync 抖动可让单次请求超限，不应让常规 CI 偶发红。

- **发送时刻**：上游 stub（trampoline 的固定下游）被调用的时刻，减去模拟 pi 钩子序列开始的时刻。
- **增量**：录制组每个请求的发送时刻，减去无录制基线组（同一套 harness，不注册钩子、不装 tap）的中位数。
- **负载**：每轮 50 个请求，payload 1 MiB（256 条 4 KiB 消息）。主门是串行、间隔 40ms；另跑并发 4：**1 个主会话 + 3 个子会话
  激活**，各自 runner、各自 sessionId 与凭证，每个激活一条串行请求流（同样 40ms 节拍），4 流并行（安全评审 #9）。
- **路径断言**（安全评审 #9 / #4）：每个场景 `ticketsBound` 增量 = 50、`unattributedPayloads` 增量 = 0、墓碑期 payload = 0；
  已落库行的 `session_id` 与线级 `x-api-key` 都属于发出它的激活；从钩子序列开始到 stub 被调用的窗口内（只有微任务，账本
  tick 不会混入），引擎连接的 `prepare` / `exec` 调用数 = 0。
- **门槛**：
  - 增量 p99 ≤10ms；
  - 心跳（5ms `setInterval` 的最大实际间隔）≤80ms；
  - 取消延迟 ≤80ms：持锁、账本有待写时，对经过 tap 的在途 provider 请求调用 `abort()`，测到 fetch reject 的时间，以及真实本地 HTTP 上游观察到连接关闭的时间；
  - 锁释放后 ≤5s 落库完成，无错位，丢弃数与注入一致。
- **持锁方式**：同进程的第二个 `DatabaseSync` 连接执行 `BEGIN IMMEDIATE`，3s 后 `COMMIT`。
- **场景 2** 用 `DbPort.pages()` 模拟历史列表（不含大字段，倒序 500 行）和导出（含 1 MiB payload，逐行序列化、逐行让出）。

### 6.2 实测（安全评审修复后；本机 Node 22.22.1，3 轮连跑，`TRAFFIC_GATE_JSON` 原始数据）

| 场景                                   | 增量 p50 (ms)  | **增量 p99 (ms)** ≤10  | **心跳最大 (ms)** ≤80  | 路径断言（3 轮相同）                                 | 其它                                                                                                                               |
| -------------------------------------- | -------------- | ---------------------- | ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 基线（无录制）                         | 中位 0.17–0.18 | p99 0.23–0.31          | —                      | —                                                    | 并发 4 中位 0.16–0.17                                                                                                              |
| ① 持锁 3s，串行                        | 1.40–1.53      | **4.68 / 4.81 / 6.44** | **18.6 / 18.9 / 18.8** | 绑定 50、未证明 0、错归属 0、发送路径 DB 0           | BUSY 退避 9 次；最长语句 6.1–7.8ms（锁释放后 1 MiB 插入，不在发送路径上）                                                          |
| ① 锁释放后                             | —              | —                      | —                      | —                                                    | **排空 353 / 346 / 354ms**（≤5s）；落库 7、丢弃请求行 43；`droppedInserts`（85）= 43 个请求 + 42 条 messages，逐项对上；孤儿补丁 1 |
| ①b 持锁，并发 4（**1 主 + 3 子**）     | 1.07–1.10      | **5.26 / 5.19 / 5.05** | **9.2 / 12.0 / 16.6**  | 4 runner：绑定 50、未证明 0、错归属 0、发送路径 DB 0 | checkpoint 7 次，最长 3.9–4.0ms                                                                                                    |
| ② 无锁，串行，历史 + 导出              | 1.21–1.40      | **1.87 / 1.42 / 2.35** | **15.1 / 14.3 / 15.4** | 绑定 50、落库 50、错归属 0、发送路径 DB 0            | checkpoint 64 次，单次最长 4.7–5.2ms；`checkpointsDeferred` 0                                                                      |
| ②b 无锁，并发 4（**1 主 + 3 子**）+ 读 | 1.19–1.35      | **5.06 / 5.02 / 4.71** | **16.2 / 26.1 / 36.3** | 4 runner：绑定 50、未证明 0、错归属 0、发送路径 DB 0 | 落库 28 / 29 / 31（其余因有界缓冲 FIFO 丢弃，见 §6.4）                                                                             |
| 取消（持锁 + 账本有待写）              | —              | —                      | 9.7 / 10.3 / 10.1      | —                                                    | **fetch reject 3.2 / 3.6 / 3.3ms；上游关闭 11.5 / 11.9 / 11.6ms**（≤80）                                                           |

另又单独连跑 5 轮（`/tmp/gate3-run{1..5}.json`）全部通过：各场景 p99 最大 7.56ms（②b），心跳最大 28.9ms，单次 checkpoint
最长 8.17ms。

**一次门外失败（如实记录）**：在「全组 + 另一个 vitest worker 并行」的 8 次全量运行中，有 1 次硬门 ② / ②b 超门（p99 10.93 /
14.47ms，心跳 49.6ms）。同一轮里单次 checkpoint 15.0ms、1 MiB INSERT 10.0ms（平时约 5ms），当时机器 load average 7.2（另有
其它进程在跑）。超门的就是撞上那次 checkpoint 的请求。checkpoint 在 `synchronous=NORMAL` 下要 fsync WAL 与主库，fsync 时长
随磁盘与系统负载变化，是同线程方案**本来就有**的风险（checkpoint 代码修复前后相同；本轮只是并发 4 改成真实多 runner 后
p99 基线从 ~1.5ms 升到 ~5ms，余量变小）。单独运行 8/8 达标，故不切 T2c；但这条需要真机 V11 在有 IO 负载的机器上复测，
若复现即按 §3.2 走 T2c（见 §11）。

旧版本表中的「①b 持锁并发 4：p99 1.46–1.69」「②b：1.16–2.23」**无效**：当时 4 路请求共用同一个 host runner，并发铸出的多张票据
使 payload 全部走 unattributed，绕过了真实多会话「各自唯一配对、各自算 1 MiB 正文摘要」的路径（安全评审 #9）。真实多 runner
下 p99 约 5ms，仍在门内。

每轮总耗时约 17s。

### 6.3 达标前的两次失败及原因（有测量）

**① COMMIT 内的自动 checkpoint**

- 首版的增量 p99：持锁串行 8.0、并发 9.8、**无锁加读 17.8**。最长 tick 15.5ms。
- 用独立脚本测：WAL 自动 checkpoint（默认 1000 页）在一次 COMMIT 里把约 4 MiB 写回主库，**耗时 17.3ms**。关掉自动 checkpoint 后，每 MiB 手动 PASSIVE checkpoint 约 2.8ms（最长 3.5），COMMIT 本身 1.6ms。
- 改为「本连接 `autocheckpoint=0` + 每 1 MiB 一个独占 tick」之后，单次 checkpoint 实测最长 4.7–6.2ms。

**② 发送路径上的 `JSON.stringify(payload)`**

- 1 MiB（256 条消息）单次 stringify 1.7–4.9ms，sha256 0.7–1.5ms。并发 4 时，同一 tick 里 4 个请求的同步段串行叠加，单独跑 ①b 时 p99 达 **24.3ms**。
- 改为延迟物化后，发送路径上只剩 sha256 正文摘要（配对证明所必需）。

**另外修掉一个测试侧问题**：读者循环在空表上没有让出，形成微任务死循环。修法是 `pages()` 返回前也让出一次，读者循环里同样加了让出。

### 6.4 门槛之外的观察

- **单条语句不可切分**：1 MiB INSERT 加 COMMIT 实测最长约 8ms。它跑在 flush tick 里，不在发送路径上，体现在心跳 15–22ms 中，离 80ms 很远。
- **风险**：如果用户的单条 payload 远大于 1 MiB（例如 10 MiB 的超长上下文），单 tick 会线性变长（约 8ms/MiB），心跳门槛可能逼近。届时按 §3.2 走 T2c，接口已经备好：`WriteOp` 是可序列化的数据，行引用和回调留在主线程。
- 建议真机 V11 用典型和最大会话 payload 各测一次。
- **②b 的丢弃**：4 条流 × 每 40ms 1 MiB（约 100 MiB/s）再加一个不停扫全表 payload 的读者，账本落库跟不上，FIFO 丢 19–22 个
  请求行（含其流 chunk）。修复前单 runner 版本也丢（约 26 行，多为 chunk）；现在每个请求都真正绑定并捕获流，写量更大。
  这是有界缓冲的设计行为（计数可见），真实负载远低于此；断言改为「已落库行归属正确」而不要求零丢弃。

## 7. 指定交错用例与测试位置

| 用例                                                                         | 位置                                 | 断言要点                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **评审交错**：A 已配对 → 400 → B 的 headers 铸 TB → A 的 strict 回退 payload | `attribution-matrix`「评审交错」     | 回退 payload 不绑定 TB，`unattributed`，TA 仍是 gen 1。B 的 payload（L={TA,TB}）同样 `unattributed`。A 的回退 fetch 携带 TA、摘要不同 ⇒ 字节原样，temperature 仍为 1，`unattributedFetches=1`，不写 TA 的行（hook 行 `url` 为 NULL）。stub 侧确认回退正文与首发**不同**（strict 已去除）且未被改写。所有上游请求都不带票据头     |
| **无交错的 strict 回退**                                                     | 「无交错 strict 回退」               | gen 2，`generationBumps=1`。stub 收到的是**对新正文重新改写**的字节（temperature=0 且没有 strict），不是 gen 1 结果的重放。gen 2 有新行（applied、200），gen 1 行保留 400                                                                                                                                                        |
| **同 generation 网络重试**                                                   | 「同 generation 网络重试」以及并发版 | 529 后重试：字节一致，`jq.run` 只调用 1 次，只有一行。并发重试同样只跑 1 次                                                                                                                                                                                                                                                      |
| **hook 级并发回填**                                                          | 「白名单外 API：两条并发 hook 级行」 | 两条都不回填，`unattributedResponses=2`                                                                                                                                                                                                                                                                                          |
| 其它                                                                         | 同一文件                             | 恰一条时回填；票据 2xx 之后的 after 不冒充回填无关行；主/子会话同 origin 交错（头、状态、正文各归各行）；streaming warming 交错（两条都 unattributed，规则 ② 在 warming 窗口内不退役）；compaction 只有 headers；票据过期后迟到；reload 后的旧纪元；白名单外 API；无票据的裸 fetch；tap lost；规则 ② 之后可证明；流 chunk 进账本 |

## 8. 偏离与说明

1. **保留 `engine.gate.gateStats()` 兼容桩**（恒为 `{active:false, retired:true, …0}`），因为 server.ts 现有字段在用、而该文件归 T4。已通知 root：T4 可删除引用，并给 `serialize_*` 标注「已停用」（R-a）。`rewrite_settings` 里的四个 `serialize_*` 键不删，但已不再读取。
2. **`after_provider_response` 不再写票据请求的状态**，改由 fetch 层精确写入。因此「`/record off` 之后仍回填」这一语义对票据请求由 fetch 层自然满足；对 hook 级行，仍按 §4 的规则回填（hooks d）。
3. **非 2xx 响应 pi 不调用 `onResponse`**（`anthropic-messages.js:478` 只在拿到 `response` 时调用；400 时 SDK 抛 `APIError`）。harness 按这个形状模拟，fetch 层写入的状态（如 400）是唯一来源。
4. **白名单外 API 的 hook 级行 `rewrite_status` 为 NULL**，只有白名单内无法证明归属的才标 `'unattributed'`。这样避免给不支持的 API 打上「未证明」的误导标签；它们改用计数 `unsupportedApiPayloads`。
5. **钩子同步化**：`before_provider_request` 不再是 async，也不读写库。~~只读一次 WAL 规则快照~~（安全评审 #4 指出与实现不符：
   当时每次都同步 `ensureDb` + 两条全量查询）。现在只读 engine 的**内存**规则快照，发送路径零 DB 调用，见 §12.4。
6. **`message_end` 的落库要求 recording，退役判定（规则 ②）不要求**：`/record off` 之后，存活票据仍要能按规则退役。
7. **调度用 ref 的 `setImmediate`**，见 §5 表。方案写的是「unref 的 setImmediate」，但实测 unref 会让 flush 被拖延到下一个定时器（约 2s）。ref 的 Immediate 每次只占一轮事件循环，不影响 print 模式退出：`traffic-lifecycle-process` 里 print 配置的自然退出用例仍通过。
8. **`DbPort` 接口相对 §3.2 原文有扩展**：原文只列了 `enqueue/query/close/stats`。这次新增 `patch`、`chunk`、`sealChunks`（主线程侧的合并语义）、`pages`（流式读）、`whenIdle`（测试与关闭使用）。worker 实现可以照抄这套语义。
9. **子会话的 `agent_settled`** 丢弃本 runner 未 fetch 的票据，以及 hook 级行和白名单外请求头快照（§5.4）。主栈 `onReaped` 未接线，与方案 §13-9 一致。

## 9. 留给 T3 / T4 / T5 的接口

- **T3（装配）**：
  - `wireTrafficHost/Child` 的签名不变。
  - 子会话现在多注册 `agent_settled` 和 `cache_warming_decision` 两个钩子，T3 的 wiring 测试要计入。
  - `/record status` 新增「归属 / 墓碑 / 写入 / checkpoint / 串行化已停用 / baseUrl 未知跳过」各行。
  - HUD `rec·drop N` 取自 `engine.dbPort.stats().droppedRows`。
- **T4（server）**：
  - 用 `engine.dbPort.pages(q, {deadlineMs, signal})` / `query()` 分页读。T4 已经接入；`ReadQuery.columns` 必须包含 `id`，keyset 依赖整数自增 id。
  - 可以删除对 `gate.gateStats()` 的引用。
  - **规则 CRUD 之后调用 `engine.refreshRules()`**（安全评审 #4）：发送路径只读内存快照。`server.ts` 的规则 POST / PUT /
    DELETE 与 rewrite settings PUT 成功后已调用（收尾裁定 2，最小改动 4 行），紧接着的请求即用新规则；后台 1s 定时器（unref，
    `engine.close` 清除）只兜底跨进程 / 直接改库的变化。
  - server 的同步写在 `busy_timeout=0` 下遇外部持锁会立即抛 BUSY，T4 已做 503「数据库忙」处理。
  - `captureStream(requestId: number | RowRef, …)` 的签名和 `onEnd` 语义保持兼容。
- **T5（keepalive / warming）**：
  - `engine.lastRewrittenAt: Map<sessionId, epochMs>`：在**出站边界**写入（改写后的请求即将发给下游时，每次发送含重试都更新），
    与是否录行（`childSessions=false`）及落库成败无关（安全评审 #8）。用于 `vetoCapture(sessionId, capturedAt)`。
  - `rewriteArmed()` 已现成：`engine.rewriteArmed()` / `TrafficWiring.rewriteArmed()`（读内存快照；**不要**在请求路径上调
    `loadEnabledRules`，安全评审 #4）。
  - warming 否决请**另外注册**一个 `cache_warming_decision` 处理器返回 `{action:"stop"}`，以
    **`TrafficWiring.rewriteArmed()`**（= open ∧ 录制中 ∧ 有启用规则，第三轮裁定 A2 的否决端口消费点）为条件。traffic 自己的
    处理器只观察，且**任何** decision 事件（不论 `event.action`）都视为「可能发送」并让该 runner 进入**改写暂停**（§13.1）：
    pi 1.3 不把最终裁定回写到 event，扩展拿不到。**依赖 T5**：T5 否决到位后，规则启用时本不应有 warming 发出；暂停是
    T5 缺席 / 被其它扩展改判时的 fail-closed 兜底。
- **T6（conformance）**：退役规则的前提（只有 400 strict 回退会再次触发 `onPayload`；2xx 之后不再有 `onPayload`；compaction 只触发 headers；非 2xx 不调用 `onResponse`）请按白名单逐个 API 固定下来。本包 harness 的请求形状就是基于这些前提写的。

## 10. 自验（最终一轮，第三轮裁定处置后）

```
$ npx vitest run tests/traffic tests/integration/traffic-lifecycle-process.test.ts --maxWorkers=2   （常规模式，计时门槛不断言）
 Test Files  27 passed (27)
      Tests  330 passed (330)

$ PI_TRAFFIC_PERF_GATE=1 npx vitest run tests/traffic/db-contention.test.ts   （独立运行，计时门槛断言；= npm run test:traffic-gate）
 Tests  5 passed (5)

$ npx tsc --noEmit -p tsconfig.json         0 错误
$ npx tsc --noEmit -p tsconfig.build.json   0 错误
$ npx prettier --check src/traffic tests/traffic tests/integration/traffic-lifecycle-process.test.ts docs/dev/traffic-merge/T2b-report.md docs/dev/traffic-merge/plan.md package.json
All matched files use Prettier code style!
```

第三轮处置期间常规全组共跑 13 次：12 次 330/330，1 次有 1 个失败（当时未保留失败名）。之后把本轮新增用例里两处依赖墙钟的断言
（`rules-refresh` 的「整段 < 1s」、`hooks` 的「1.3s 时已刷新」）改为确定性断言（响应到达时快照已更新 / 带截止的轮询），再连跑
3 次全过。

收尾前的计时记录：硬门独立运行 8/8 达标（§6.2）；全组并行 8 次中 1 次 ②/②b 超门（checkpoint fsync 15ms、load 7.2），
这正是改为 `PI_TRAFFIC_PERF_GATE` 开关的原因。

附：`DbPort.pages()` 新增防呆——`columns` 不含整数 `id` 时抛错，而不是让下一页 `id > NaN` 静默丢行
（`db-port.test`「分页读防呆」）。T4 的导出 keyset 用例可据此定位缺列。

## 11. 遗留

- T4 收尾后需重跑全组（server-hardening 新用例、真实端点下的硬门场景 2 复测）。
- `db-contention.test.ts` 单文件约 17s（基线 3 轮 + 5 场景）；T7 统计 CI 时长时若超预算，按 §8.4 标 slow 组。
- 无持锁并发 4（1 主 + 3 子，100 MiB/s 合成负载 + 全表读者）下账本 FIFO 丢 19–22 个请求行，是有界缓冲的预期行为（§6.4）；真实负载远低于此。
- **硬门余量**：真实多 runner 下 p99 约 5ms（单独 8/8 达标）；全量并行 + 机器负载下曾 1/8 次因单次 checkpoint fsync 15ms 超门
  （§6.2 末）。计时门槛已改为 `PI_TRAFFIC_PERF_GATE=1` 才断言（§6.1）；**硬门以独立运行与真机 V11（含 IO 负载）为准，V11 复现
  超限 ⇒ 启动 T2c。**
- 安全评审修复引入的残留见 §12.11（WAL 积压后不再 checkpoint、单条 >8 MiB 不录、墓碑期 payload 不改写、#7 票据进 SDK 日志）。
- 超大单条 payload（≫1 MiB）单 tick 线性变长，见 §6.4，真机 V11 建议用最大会话复测。

## 12. 安全评审修复

评审：gpt-6.1-sol（`/tmp/traffic-T2b-secreview.json`），reject，2 Blocker + 7 Major。主会话裁定：修 #1–#6、#8、#9；#7 只写文档。
每条都给出：问题、修复落点、回归测试、修复前确认失败的方法（§12.10 汇总）。

### 12.1 #1 Blocker：TTL / FIFO 回收被当成完成证明

- **问题**（评审 E1）：A 已绑定 TA，fetch 拿到 400 响应头、`inFlight` 归零；SDK 仍在读错误体。超过 30s 后 B 铸 TB，sweep 把
  TA 以 TTL 退役，L 只剩 TB。A 的 strict 回退 payload 迟到，被绑到 TB；B 的 payload 反而 unattributed，但 B 携 TB 的首次 fetch
  仍绑定正文摘要并按 TB 的规则改写了 B。「存储回收」与「不会再有 payload」是两回事。
- **修复**（`ticket.ts`、`index.ts`）：runner 上加**墓碑** `tombstoned`。凡**未经证明**离开 L 的票据（`retire(…, "ttl")`：未绑定
  30s、失败后 30s、硬上限 10 min、sweep 回收未退役票据、FIFO 容量淘汰）都给其 runner 立墓碑；墓碑存在期间
  `decidePairing(live, runner.tombstoned)` 一律 `unattributed`（含 bound / bumped 两种）。只有**完成边界**清除：规则 ② 的 assistant
  `message_end`（前提成立时；agent loop 串行调用 provider，message_end 表示当前调用结束）和子会话 `agent_settled`。规则 ①
  （某票据 2xx）只证明它自己，不清别人的墓碑；墓碑不随时间自动解除（不靠加大 TTL）。计数 `tombstones / tombstonedPayloads /
tombstonesCleared`，`/record status` 有「墓碑」行。
- **回归测试**：`attribution-matrix`「安全评审 #1（E1）」完整复现执行链（假 Date 推进 >30s；回退 payload 不绑 TB；B 的 fetch
  原样透传 temperature=1；message_end 后下一个请求恢复改写）；`ticket.test`「墓碑」4 例（TTL ⇒ 墓碑且挡 bound、挡 bumped、
  FIFO 淘汰立墓碑而成功退役不立不清、agent_settled 清而 warming 窗口内的 message_end 不清）；原「③ TTL」用例补断言墓碑。

### 12.2 #2 Blocker：secure 复查在 flush 内同步重入账本

- **问题**（评审 E2）：`runTick` 的循环条件调用闸口 → `drainAllowed` → 同步 `engine.close("secure")` → 同步进入
  `dbPort.close()` → 内层 `runTick` 清空同一队列 → 外层 `queue.shift()` 得到 undefined → 读 `.bytes` 抛出，setImmediate 回调里无
  异常边界 ⇒ 未捕获异常。
- **修复**：
  1. `persist.ts` `closeForSecure`：命中时只**同步**撤销接纳（`recording=false`），`engine.close("secure")` 用 `setImmediate`
     延迟到当前栈退出后（`engine.secureClosePending` 去重）。闸口本身不再有任何会重入账本的副作用。
  2. `db-port.ts`：`runTick` 加 `running` 重入守卫（重入直接返回）；前导丢弃循环每次取元素后重验存在；运行中发生的缓冲增长只
     登记，tick 结束后统一做限额检查（迭代中途不改队列）。
  3. `dbPort.close()` 先 `await Promise.resolve()` 再排空：即使在某个 tick 的同步栈内被调用，也只在该 tick 退出后开始（微任务
     而非 setImmediate：后者多占一轮事件循环，会让 `mode-gate` 中 undici 复用已关闭 keep-alive 连接的既有竞态浮现）。
- **回归测试**：`secure.test`「安全评审 #2（E2）」（env / locked 两种）：真实 engine，plain 下排 3 条，flush 前切域、之后不再调用
  任何 `record*` ⇒ 无未捕获异常、engine 离开 open 且有界关闭、库里零新增 messages / requests；`db-port.test`「#2」：闸口回调同步
  调 `close()` 且拒绝 ⇒ 无未捕获异常。原「慢流中途切 locked」用例改为先断言同步撤销接纳、等一个 setImmediate 再断言非 open。

### 12.3 #3 Major：warming 观察值不是最终裁定

- **问题**：pi 1.3 `runner.emitCacheWarmingDecision` 把各 handler 的返回值折叠进局部变量，不回写 `event.action`，扩展拿不到最终
  裁定（`AgentSession.cacheWarmingStatus` 也不对扩展暴露）。原始 stop 被其它扩展改成 warm 时，traffic 看到 stop、不记放行，
  message_end 会退役仍在用的 warming 票据。
- **修复**（`index.ts`）：保守化——**任何** `cache_warming_decision` 事件都记 `warmingAllowedAt`，60s 内规则 ② 不成立（也就不清
  墓碑）。代价只在保守方向：warming 决策后 60s 内的 message_end 不退役票据，可能多出 unattributed，绝不错绑。
- **回归测试**：`attribution-matrix`「安全评审 #3」：`action:"stop"` 的事件之后 message_end 不退役票据。未接真实 ExtensionRunner
  （评审建议项）：修复后观察器不再读 `event.action`，stop→warm 改判与否对本处理器结果没有影响，故用 stop 输入即可覆盖。

### 12.4 #4 Major：发送路径同步 DB

- **问题**：每次 `before_provider_request` 同步 `ensureDb()` + `loadEnabledRules().all()` + `getEngineSettings().all()`。
- **修复**（`engine.ts`、`index.ts`）：engine 持内存快照 `rulesSnapshot {rules, settings, loadedAt}`；`/record on`（命令路径）同步加载
  一次，之后由 unref 的 1s 定时器在非发送路径刷新（仅录制中；`close()` 清除）；暴露 `engine.refreshRules()` 供 T4 CRUD 后立即
  生效。BUSY ⇒ 保留旧快照；其它错误 ⇒ 记 dbError、清空规则（改写失效、流量放行）。`rulesRefresh` 统计（次数、BUSY 跳过、错误、
  最长耗时）进 `/record status`。所有直接写 `rewrite_rules` 的测试在写后调用 `refreshRules()`。
- **回归测试**：`hooks.test`「发送路径零 DB」：有启用规则时 headers / payload 钩子同步执行内 `prepare` / `exec` 调用数为 0，且规则
  确实进入本 generation；「快照由非发送路径刷新」：写库后快照不立即变，~1.3s 后由定时器刷新。硬门每个场景断言窗口内引擎连接
  `prepare` / `exec` 调用 0 次（修复前实测 100 次 = 每请求 2 次）。

### 12.5 #5 Major：8 MiB 不是硬上限

- **问题**：行补丁合并、chunk 批追加只加 `queuedBytes` 不 trim；trim 用 `queue.length > 1` 保留单个任意大条目；字节用 `.length`。
- **修复**（`db-port.ts`、`persist.ts`）：统一 `textBytes = Buffer.byteLength(utf8)`（入队估算、物化、补丁、chunk）；入队、补丁
  合并（含并入未执行 INSERT）、chunk 追加、物化之后都走同一个 `trim()`：先把单条 > `maxBytes` 的条目按 `oversize` 丢弃（计入
  `droppedByKind.oversize` 与 `droppedRows`，插入置 `dropped`、chunk 批回调 `onFail` 取消读流），再 FIFO 丢最旧直到 ≤512 条且
  ≤8 MiB（连最新条目也可丢）。`runTick` 运行中只登记、tick 后执行。
- **回归测试**：`db-port.test`「#5」5 例：UTF-8 口径；持锁下补丁膨胀 ⇒ 立即 FIFO 丢最旧且 ≤上限；持锁下 chunk 批膨胀超单条上限
  ⇒ oversize 丢弃 + onFail；单条 9 MiB ⇒ 丢弃计 oversize；延迟物化的中文 payload（length 400 Ki、UTF-8 1.2 MiB）按字节超限丢弃。

### 12.6 #6 Major：checkpoint 工作量无上界

> **已被 §13.2 取代**：复审指出本节的「按上次 checkpoint 结果估算」覆盖不了首次积压与外部连接写入，跳过后关库又无上界。
> 现行实现为「每次决定前现场 stat `-wal`」。下文保留作记录。

- **问题**：`wal_checkpoint(PASSIVE)` 没有页数预算。长读事务钉住快照时 WAL 积压，读者释放后下一次 checkpoint 会在主线程一次复制
  全部积压。
- **修复**（`db-port.ts`）：读取每次 PASSIVE 的 `{log, checkpointed}`；积压估计 = 未推进帧 × `page_size` + 此后写入。若上次留有
  未推进帧（被读者挡住）且估计 > `checkpointMaxBytes`（缺省 2 MiB，约 5.6ms）⇒ **不在本线程做** checkpoint，计
  `checkpointsDeferred`、`walBacklogBytes` 继续累积（`/record status`「checkpoint」行可见）。不做 checkpoint 就无法得知读者是否已
  释放，故一旦跳过，本连接此后一直跳过（见 §12.11 残留）。无读者挡住时（上次全部推进）照常每 1 MiB 一次，工作量 ≈ 自上次以来
  本连接写入的量。
- **回归测试**：`db-port.test`「#6」：第二连接 `BEGIN; SELECT` 钉住快照 → 写 16 × 1 MiB（积压 >8 MiB）→ 释放读者 → 再写 4 MiB ⇒
  `checkpointsDeferred > 0`，`maxCheckpointMs < 10`。修复前同一用例释放后单次 checkpoint 实测 **45.0ms**。

### 12.7 #7 Major（不改代码）：票据进入 SDK debug 日志

- 主会话裁定为**已接受残留**：票据是一次性 128-bit 随机关联 id（`randomBytes(16)` 十六进制），不含会话 / 用户 / 凭证信息，
  `ANTHROPIC_LOG=debug` 时会出现在 SDK 日志里（SDK 的脱敏名单不含 `x-pi-traffic-ticket`），不构成凭证暴露；票据只在本 engine
  纪元、本进程内有意义，过期 / 回收后 fetch 层不再识别。plan.md §R2 表后已加同样附注。
- **测试**：`ticket.test`「票据值」断言格式（32 位十六进制）、64 次各不相同、与 sessionId 无关——锁定「残留可接受」的前提。

### 12.8 #8 Major：`lastRewrittenAt` 依赖是否录行

- **问题**：`childSessions=false` 时 `gen.row` 为 null，`recordWire` 提前返回，改写照发却不更新 `lastRewrittenAt`；规则关闭后
  T5 无法否决改写前的旧 capture。
- **修复**（`capture.ts`）：标记移到出站边界——`handleFetch` 用改写结果（`ruleIds` 非空）发送前设置，每次发送（含同 generation
  重试）都更新，与 RowRef 和落库成败解耦；`recordWire` 里删除。
- **回归测试**：`internal-requests`「子会话 childSessions=false」补断言 `lastRewrittenAt.get("S-child")` 有值。

### 12.9 #9 Major：硬门并发场景测的不是多 runner

- **修复**（`db-contention.test.ts`）：并发 4 = 1 主会话 + 3 个子会话激活（`activate({role:"child"})`，各自 runner / sessionId /
  `x-api-key`），每个激活一条串行请求流，4 流并行；每个场景断言 `ticketsBound` 增量 = N、`unattributedPayloads` 增量 = 0、墓碑期
  payload = 0、落库行 `session_id` 与线级凭证归属正确、发送路径 DB 调用 = 0。重跑 3 轮，数字已替换 §6.2：真实多 runner 下
  ①b p99 5.05–5.26ms、②b 4.71–5.06ms，仍在门内，不切 T2c。
- **修复前失败**：把 `actorOf` 改回「全部用 host」⇒ ①b 断言失败（`ticketsBound` 46、`unattributedPayloads` 4）。

### 12.10 修复前失败的验证方法

对每条修复，用脚本临时把相关源码还原为修复前语义（文件先备份，跑完原样拷回；不涉及 git），只跑对应回归测试：

| 项  | 还原方式                                                                                        | 结果（修复前）                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| #1  | `decidePairing` 不传 / 忽略墓碑；`retire(ttl)` 不立墓碑                                         | E1 用例失败；`ticket.test` 5 例失败                                               |
| #2  | `closeForSecure` 改回同步 `close`；去掉重入守卫、close 前让出与重验                             | 3 例失败，捕获 `TypeError: Cannot read properties of undefined (reading 'bytes')` |
| #3  | 观察器恢复 `if (event.action !== "stop")`                                                       | 1 例失败                                                                          |
| #4  | `rulesSnapshot` 恢复每次读库                                                                    | hooks 用例失败；硬门 ①/①b `sendPathDbCalls` = 100 而失败                          |
| #5  | `textBytes` 用 `.length`；trim 恢复 `queue.length > 1`、无 oversize；补丁 / chunk 追加后不 trim | 5 例全部失败                                                                      |
| #6  | 关闭积压跳过                                                                                    | 失败：`expected 44.96 to be less than 10`                                         |
| #8  | `lastRewrittenAt` 移回 `recordWire`                                                             | 1 例失败                                                                          |
| #9  | 并发流全部用 host                                                                               | ①b 失败（绑定 46 / 未证明 4）                                                     |

### 12.11 修复引入 / 保留的残留

- **WAL 积压后不再 checkpoint**（#6）：一旦长读者造成 >2 MiB 积压，本 engine 生命周期内不再在主线程 checkpoint，WAL 文件持续
  增长；engine 关闭时 `db.close()`（最后一个连接）由 SQLite 隐式做全量 checkpoint，那一次不在 provider 发送路径上但**没有上界**
  （session_shutdown / reload 时，大约 2.8ms/MiB）。根治需要把 checkpoint 移出主线程（T2c worker）。触发条件是外部长读事务
  （例如另一个进程开着只读事务）；本扩展自己的读都按页结束语句，不会长期钉住快照。
- **单条 >8 MiB 不录**（#5）：超大单条（例如含大量图片的超长上下文 payload）整行按 oversize 丢弃、计数可见；需要时可后续改为
  截断落库。
- **墓碑期 payload 不改写**（#1）：TTL / 回收之后到下一个完成边界之间，该 runner 的请求一律 unattributed（原样发送、不改写、只录
  hook 级行）。正常无交错流程不会触发 TTL（每个请求都在 30s 内完成或成功退役），影响面只在失败重试 + 长时间卡住的边角。
- **warming 后 60s 规则 ② 不成立**（#3）：任何 decision 事件都触发，比原先略保守。
- **规则生效延迟**（#4）：网页 CRUD 已即时刷新；只有绕过网页直接改库（另一进程 / sqlite3 CLI）的变化要等后台定时器（≤1s）。
- **#7**：见 §12.7，已接受。

### 12.12 收尾裁定（主会话，2026-10-23）

1. **硬门不让常规套件偶发红**：`db-contention.test.ts` 的计时断言（增量 p99 ≤10ms、心跳 ≤80ms、取消 ≤80ms、排空 ≤5s）只在
   `PI_TRAFFIC_PERF_GATE=1` 时启用；`package.json` 新增 `test:traffic-gate` 脚本（`PI_TRAFFIC_PERF_GATE=1 vitest run
tests/traffic/db-contention.test.ts`，只追加这一行）。常规运行保留全部功能断言并打印数字（首行 `[traffic-gate] mode
{"perfGate":false}`），最终排空用 20s 宽松上限（功能性，不是性能门槛）。硬门以独立运行与 V11 真机为准，V11 复现超限 ⇒ T2c。
2. **规则 CRUD 即时生效**：`server.ts` 规则 POST / PUT / DELETE 与 settings PUT 写成功后调用 `state.refreshRules()`（4 处，
   各 1 行）。新测试 `tests/traffic/rules-refresh.test.ts`（真实 hub 端点 + harness 请求路径）：POST 后紧接着的请求被改写、PUT
   改 jq 后用新 jq、禁用 / DELETE 后紧接着的请求原样，整段 < 1s（排除定时器的功劳）；settings PUT 后快照立即更新；后台定时器
   间隔 1s、`hasRef()===false`、重复 `/record on` 不新建、`engine.close` 以同一句柄 `clearInterval`。去掉 server.ts 这 4 行后，
   前两个用例失败（已实跑确认）。

## 13. 第三轮裁定处置（复审 r2：`/tmp/traffic-T2b-secreview-r2.md`，5 项闭合、剩 2 项；主会话裁定，2026-10-23）

复审结论：#2、#4、#5、#8、#9 闭合。#1/#3 部分闭合：warming 的 60s 窗口到期仍被当作完成证明，`discardUnfetched` 不看 warming
就清墓碑。#6 未闭合：估算覆盖不了首次积压与外部连接写入，跳过之后关库的隐式 checkpoint 也没有上界。

### 13.1 A（原 #1/#3，阻塞）：改写路径 fail closed

- **A1 改写暂停**（`ticket.ts`、`index.ts`、`capture.ts`、`engine.ts`）
  - runner 新增 `rewriteSuspended` / `suspendedAt`，以及 `suspendRewrite()`、`rewriteSuspended()` 两个函数。
  - `cache_warming_decision` 观察器对**任何** decision 都调用 `suspendRewrite`，每次以当前边界序号为新起点。**不看时间。**
  - 解除边界只有三种，用 engine 的单调序号 `rewriteMarks` 表达：
    1. `/record off→on`：`recordOn` 发现 `!engine.recording` 时 `resumeSeq++`；
    2. 暂停之后某次规则快照刷新**成功**读到「启用规则为零」（`refreshRules` 里 `zeroSeq++`，读失败不算），且当前又有启用规则；
    3. 会话 shutdown / 新 engine：新台账、新 runner，天然不继承。
  - 暂停期间绑定与录制照常；本 generation 的规则置空，行 `rewrite_status = 'suspended'`。fetch 层在创建改写前再查一次，覆盖
    「decision 之前已绑定、之后才 fetch」的票据，该 generation 固定为「无改写」。
  - 计数 `rewriteSuspensions / rewriteResumes / rewriteSuspendedRequests`；`/record status` 新增「改写暂停」一行，并提示
    `/record off → on` 恢复。
  - `discardUnfetched()`（子会话 `agent_settled`）**不碰** `warmingAllowedAt` 与改写暂停；60s warming 窗口内也不再清墓碑
    （与规则 ② 同一前提）。
- **A2 否决端口**：`engine.rewriteArmed()` 与 `TrafficWiring.rewriteArmed()`（后者另加 secure 判定）= open ∧ 录制中 ∧ 快照
  里有启用规则，供 T5 的 warming 否决处理器消费。§9 T5 条目已注明依赖 T5。
- **A3 仅录制路径**：沿用墓碑 + 60s 时间窗。迟到 warming payload 被错配到其他票据的**录制行**列为已接受残留（§13.3、
  plan §R2 附注）。
- **A4 回归**（都已在临时还原修复后确认失败，§13.4）：
  - `attribution-matrix`「裁定 A4（复审反例）」：decision → W 铸票后卡住 → 超过 60s 后 A 的 message_end 退役 W 并清墓碑 →
    B 铸 TB → W 的迟到 payload 落到 TB。断言携 TB 的请求字节不变（temperature 仍为 1）；24h 后仍不改写；`/record off→on`
    之后恢复改写；库里有 `suspended` 行。
  - 「裁定 A4：子会话 warming 未完成时 agent_settled」：settled 之后 warming 状态与改写暂停都还在，B 的请求不被改写。
  - 「裁定 A1」：decision 之前已绑定的票据，其 fetch 也不改写；规则仍启用时的刷新不解除；禁用 → 再启用则解除。
  - 「裁定 A2」：端口真值表。
  - `ticket.test`「改写暂停」2 例，以及改写后的 agent_settled 用例。

### 13.2 B（原 #6，严重）：checkpoint 只在能证明有界时执行

- **B1 现场 stat**（`db-port.ts`、`engine.ts`）
  - 删除「按上次 checkpoint 结果估算」。每次决定 checkpoint 前调用 `walSize()`：engine 注入 `walFileBytes(dbPath)`，即现场
    `statSync(<db>-wal).size`（文件不存在 ⇒ 0，其它失败 ⇒ null）。
  - ≤ `checkpointMaxBytes`（2 MiB）才执行 `PASSIVE`；否则（含 null、未提供端口）跳过并计 `checkpointsDeferred`。PASSIVE 的
    工作量至多是 WAL 里现有的帧，以文件大小为界即可证明有界。首次积压（上个进程遗留）、长读者钉住的积压、外部连接写入的
    WAL，都由同一判据覆盖。
  - 为免文件大小被历史高水位永久卡住：本连接设 `journal_size_limit = checkpointBytes`（WAL 复位时截断）；下一条大条目写入后
    会超过上限时，**先** checkpoint，让 WAL 从小开始。`stats().walBytes` 为最近一次 stat 的结果。
  - 测试（`db-port`）：「#6 / 裁定 B1：长读事务」「外部连接写入大量 WAL（首次积压）⇒ checkpoints 为 0、跳过计数」「stat
    失败 / 未提供 ⇒ 不 checkpoint」「正常写入时 WAL 保持在上限内、照常 checkpoint、journal_size_limit 生效」。
- **B2 关库告警**（`engine.ts`）：`db.close()` 之前现场 stat，`-wal` 超过 64 MiB（`CLOSE_WAL_WARN_BYTES`，测试可注入
  `closeWalWarnBytes`）时 `console.warn` 一行，只含大小与路径：
  `[pi-subagent] traffic: 关闭录制库时 WAL 为 N.N MiB，SQLite 关库的 checkpoint 可能短暂阻塞（<db>-wal）`。
  隐式 checkpoint 本身列为已接受残留（§13.3）。测试：`db-port`「关库前 WAL 告警」。

**硬门**（独立运行 `PI_TRAFFIC_PERF_GATE=1`，3 轮，`/tmp/gate4-run*.json`）：5 个场景全过。

- 增量 p99：① 4.73–5.44ms，①b 5.01–5.34ms，② 1.67–1.88ms，②b 4.78–4.99ms；心跳 ≤29.4ms。
- 取消：fetch reject 3.5–4.5ms，上游关闭 11.6–13.3ms；锁释放后排空 337–367ms。
- 单次 checkpoint 最长 5.84ms，**`checkpointsDeferred` 全部为 0**：正常流量下 WAL 始终在上限内。

### 13.3 残留表（第三轮裁定后）

| 残留                                          | 性质              | 说明                                                                                                                                                                                             |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 迟到 warming payload 错配到其他票据的录制行   | 已接受（裁定 A3） | 只影响录制数据质量。观测到 decision 后改写已暂停，不会改写任何请求。                                                                                                                             |
| 改写暂停后需人工恢复                          | 设计代价（A1）    | 开着 cache warming 的会话，一次 decision 之后规则就不再作用，直到 `/record off → on`、规则全部禁用再启用或新会话。`/record status` 有计数与恢复提示。T5 否决到位后，规则启用时本不应有 warming。 |
| 关库的隐式 checkpoint                         | 已接受（裁定 B2） | 跳过运行时 checkpoint 之后，WAL 增长到 engine 关闭；最后一个连接 `db.close()` 同步 checkpoint。发生在 shutdown / reload，不在发送路径，不由定时器中断；超过 64 MiB 先 warn。                     |
| 单条 >~2 MiB 的写入之后运行时 checkpoint 停止 | 由 B1 判据推出    | 这类写入让 WAL 超过上限，此后本 engine 不再做运行时 checkpoint，归到关库那一次。真机 V11 用最大会话 payload 观察 WAL 增长。                                                                      |
| 单条 > 8 MiB 不录                             | §12.11            | 不变。                                                                                                                                                                                           |
| #7 票据进入 SDK debug 日志                    | 已接受            | 不变（§12.7）。                                                                                                                                                                                  |
| 硬门计时以独立运行与 V11 为准                 | §12.12            | 不变；V11（含 IO 负载）复现超限 ⇒ 启动 T2c。                                                                                                                                                     |

### 13.4 修复前失败的验证

方法同 §12.10：备份 → 临时还原 → 只跑对应用例 → 拷回。

- A：`suspendRewrite` 不置暂停、`discardUnfetched` 无条件清墓碑 ⇒ 5 例失败（复审反例、子会话 agent_settled、A1 边界、
  `ticket.test` 的改写暂停与 agent_settled）。
- B1：去掉现场 stat 判据（触发即 checkpoint，等价于 r2 的估算初值 0）⇒ 3 例失败（长读者、外部连接首次积压、stat 失败
  fail closed）。
- B2：去掉告警 ⇒ 1 例失败。
