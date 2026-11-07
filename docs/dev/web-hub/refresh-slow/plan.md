# 大会话 web 刷新慢修复方案（P0+P1）— Plan

> 输入：`explore-report.md`（同目录，r_WQKG58）。范围按用户拍板：**只做 P0+P1**；P2（`subagent:archive` 写入去重）另开 #89，本方案不碰。
> 状态：待方案评审。行号基于 dev `70ca25ae`。

## 0 背景与目标

190.9 MiB / 30,612 条的活会话，打开详情页要 7.4 s。根因：`history.snapshot()` 和 `page()` 都走 `readBranchCached`：整文件 `readFile`，逐行 `JSON.parse`，整条分支 30,566 条全部投影，最后只留 400 条。约 7 s 的同步 CPU 期间 hub 所有请求都在排队，RSS 涨到 1.6 GB。
目标：snapshot 和 page 的成本只跟「要返回的那段尾巴」有关，不跟文件大小走；拆掉 256 MiB 悬崖（tail 读路径、agent 侧 `branch_reply`、`runTail` 遇 TOO_LARGE 静默）。wire 不变（`HistoryPayload` 字段、`branch_reply` 形状都不动），不碰 `tests/fixtures/`。

## 1 关键取舍（先读）

**D1：snapshot 和 page 共用一个由 history 服务持有的反向读取器，即 `run-file-reader` 的第二个实例；`readBranchTail` 只留给 `runTail` 用。**
探索报告原本建议 snapshot 用「`readBranchTail` + `chainContinues`」。这里改为复用 `createRunFileReader`，理由：

| 维度         | A：反向读取器（采用）                                                      | B：`readBranchTail` + `chainContinues`（否决，规格见 §2.6）                                |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 解析量       | 子串预滤，只 `JSON.parse` 分支命中行                                       | 每轮把整块（0.5→2→8→32 MiB）所有行全部 parse；块增长时从头重 parse                         |
| 主线程       | 每块之后 `setImmediate` 让出一次，带 deadline                              | 每块同步跑完；8 MiB 块约 80–100 ms 不让出                                                  |
| 预算悬崖     | 只有累计扫描量 `maxScanBytes`（从 EOF 起算 256 MiB），和文件总大小无关     | 超过 32 MiB 返回 `undefined`，回落整文件读（又是 7 s）；图片多的会话 400 条可能就超 32 MiB |
| 和 page 衔接 | 游标 LRU：snapshot 读到第 512 条，紧接着第一次「Show earlier」直接命中缓存 | 无状态，page 还得另写一套                                                                  |
| 单飞/并发    | 已有：同 key 单飞，全局 ≤2 并发，排队受 deadline 约束                      | 无                                                                                         |
| 等价性       | 需要补 parity 选项（§2.1），并新写等价测试                                 | 已有 190–309 的等价测试                                                                    |

**D2：共用方式是「同一模块的独立实例 + 新增 opts」，不另写一个读取器，也不和 run transcript 共用实例。** 新增的 opts 默认值都不改变现有行为，所以 run transcript（`assembly-registry.ts:55`）的行为逐字节不变。实例独立的原因：两边配置不同（parity、块大小、缓存容量），而且 history 和 run transcript 不应在同一道 ≤2 的并发门上互相饿死。全 hub 最多 4 个并发扫描，每个都是协作式的。

**D3：snapshot 读 `max(tailEntries, DELIVERED_CAP)=512` 条，不是 400 条。** 为的是让 `delivered` 基线（`pushDelivered` 只保留最后 512 个 key）跟改动前一致；代价是多读约 28%，约 10–20 ms。

## 2 P0-snapshot

### 2.1 共用底座：`run-file-reader.ts` 新增 opts（默认值保持现状）

`createRunFileReader(opts)`（`run-file-reader.ts:121`）新增三项：

- `fullReaderParity?: boolean`（默认 false），打开后行为与 `walkBranch`（`history.ts:268-291`）一致：
  1. **hasMore 精确**：`collect`（`:215-235`）中 `:233` 的 needmore 条件，parity 下改为 `j === chain.length && !cursor.done && (picked.length < q.limit || parity)`。也就是凑满 limit 但链已读完、扫描尚未结束时，再多扫出一条已投影条目（或者扫到根），才能判断 hasMore。不加这条，剩余祖先如果全是不投影的条目（label / session_info / usage / context_edit），`hasMore:true` 之后会翻出一个空页。
  2. **祖先缺失算链尾**：`:354-358` 扫到文件头时 `want` 仍未找到。parity 下，只要 leaf 已命中（`cursor.visited.size > 0`），就置 `done = true`，与 `walkBranch` 的 `if (raw === undefined) break` 一致；只有 leaf 本身没找到才是 `leaf_missing`。
  3. **环算链尾**：`processLine` 的 `:270-275`（`visited.has(want)`）parity 下置 `done = true`，与 `walkBranch` 的 `!seen.has(cur)` 一致。
- `cursorCacheSize?: number`（默认 `RUN_READER_CURSOR_CACHE_SIZE`=16，改的是 `:202`）。history 用 8：活会话每次 append 都会让游标 key 变，旧游标留在 LRU 里占内存。
- `scanChunkBytes` 的注释从「test seam」改成「默认 1 MiB；history 用 512 KiB」。按真实会话的密度，1 MiB 块约 60 条 16.5 KB 的 archive 条目，同步投影约 32 ms；512 KiB 能把每次让出前的 CPU 压到约 16 ms，对应「快照期间 `/api/version` <50 ms」这条验收。

### 2.2 `history.ts` 改动点

1. **新常量**（`:36-64` 区块）：
   - `HISTORY_SCAN_CHUNK_BYTES = 512 << 10`
   - `HISTORY_CURSOR_CACHE = 8`
   - `SNAPSHOT_READ_MIN = max(tailEntries, DELIVERED_CAP)`，在服务内按 deps 计算
   - `SNAPSHOT_READ_GROWTH_MAX = 8`：limit 最多涨到 8×MIN
   - `SNAPSHOT_FILE_BUDGET_MS = TIMING.snapshotMs / 2`（2.5 s）：文件读给自己的子 deadline，至少留一半时间给 `branch_req` 回落
2. **`createHistoryService`**（`:433`）：deps 新增可选 `readerStats?: RunFileReaderStats`（测试缝），在服务内创建
   `const branchReader = createRunFileReader({ fullReaderParity: true, cursorCacheSize: HISTORY_CURSOR_CACHE, scanChunkBytes: HISTORY_SCAN_CHUNK_BYTES, stats: deps.readerStats })`，并在 `dispose()`（`:761`）里调用 `branchReader.dispose()`。
3. **新内部函数 `readTailForSnapshot(file, leafId, needMessageLike, deadlineAt)`**：
   ```ts
   let limit = SNAPSHOT_READ_MIN;
   for (;;) {
     const r = await branchReader.read(file, leafId, { limit, maxBytes: Number.MAX_SAFE_INTEGER, deadlineAt });
     if (
       !r.ok ||
       !r.hasMore ||
       limit >= SNAPSHOT_READ_MIN * SNAPSHOT_READ_GROWTH_MAX ||
       countMessageLike(r.entries) >= needMessageLike
     )
       return r;
     limit *= 2; // 游标已缓存 ⇒ 增量扫描，不从 EOF 重来
   }
   ```
   这里 `needMessageLike = 2 × reply.recent.length`（≤ 2×`LIMITS.recentMessages` = 128），即 `mergeSnapshot` 的对账窗口（`:399`）。`maxBytes` 不在这一层截，字节预算仍由下游 `buildCappedHistoryPayload` 统一处理，与现在一致。
4. **`loadBranch`（`:625-643`）拆成两条路径**：
   - `loadSnapshotBranch(agentKey, file, leafId, reply, remaining)`：先走上面的反向读，失败或 busy 时回落 `branch_req`（回落矩阵见 §2.3）。返回 `{ entries, source, truncated, more }`，其中 `more` = 反向读的 `hasMore`；agent 路径下 `more` 恒为 false（由 `truncated` 表达）。
   - `branch_req` 那段（`:635-642`）抽成 `loadFromAgent(agentKey, leafId, remaining)`，snapshot 和 page 共用。
5. **`snapshot()`（`:647-711`）**：
   - `:651-659` 改为调用 `loadSnapshotBranch`。
   - `:692-693` 的 hasMore 改成 `merged.entries.length > entries.length || base.more || base.truncated || candidateEntries.length < entries.length`。
   - 其余不动：`mergeSnapshot`、`slice(-tailEntries)`、delivered 基线、`buildCappedHistoryPayload`、`oldestEntryId`。
6. **`readBranch` / `FileCache`**（`:467`、`:347-372`）：只剩 `runTail` 的整文件回落在用，详见 §2.5。

### 2.3 回落矩阵（snapshot）

| 反向读结果                                                   | 处置                                                 | 对照：现状                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ok`                                                         | `source:"file"`                                      | 文件 ≤256 MiB 时一样（但耗时 7 s）                                                |
| `file_missing`（ENOENT、非 `.jsonl`、realpath 不是普通文件） | `branch_req`（`source:"agent"`）+ `log.info(reason)` | ENOENT → `branch_req` ✓                                                           |
| `leaf_missing`（leaf 未落盘；leaf 行不是紧凑 JSON 格式）     | `branch_req`                                         | LEAF_NOT_FOUND → `branch_req` ✓                                                   |
| `parse_error`（**分支命中行**损坏；或 I/O 中途出错）         | `branch_req`                                         | PARSE（任意一行坏）→ `branch_req`；**放宽**：分支外的坏行不再迫使走 agent         |
| `too_large`（从 EOF 累计扫描超过 256 MiB 仍未凑够）          | `branch_req`                                         | 文件 >256 MiB 就 TOO_LARGE → `branch_req`；**悬崖消失**：超大文件的尾读照常走文件 |
| `busy`（2.5 s 子 deadline 到，或并发门排队超时）             | `branch_req` + `log.info`                            | 无对应（以前同步卡死）                                                            |
| `reply.leafId === null`                                      | 空历史，不碰文件                                     | 不变                                                                              |
| `file === undefined`（`--no-session`）                       | 直接 `branch_req`                                    | 不变                                                                              |

不再回落整文件读：反向读拿不到答案的情形，整文件读也只会给出相同结论（LEAF_NOT_FOUND / PARSE / TOO_LARGE），却要多付 7 s。

### 2.4 语义保持论证

- **entries**：投影是逐条纯函数（`projectSessionEntry`）。反向读从 leaf 沿 `parentId` 往回走，链上收到的条目集合与 `walkBranch` 相同，前提是 parent 行在 child 行之前（pi 的 append-only 写入保证这一点；run transcript 线上一直依赖这个前提，`run-file-reader.test.ts` T1–T6 已经和内存 walk 对拍过）。所以 `entries.slice(-tailEntries)` 与旧实现逐字节相同。
- **hasMore**：旧实现是 `full.length > tailEntries`。新实现读 N=512 条，有三种情况：分支总条数 ≥513，则 `base.more=true`；分支条数在 401–512 之间，则 `merged.entries.length > 400`；≤400，则两者都为 false。parity（精确 lookahead）保证 `base.more` 精确，所以结果与旧实现一致。
- **oldestEntryId**：公式不变，`candidateEntries[0].id`。
- **tailMessages**：对账窗口是 `messageLike.slice(-2|recent|)`。§2.2-3 的循环保证窗口有完整的 2|recent| 条，或者已经读到根。只有涨到 8×512=4096 条上限仍不够（即最近 4096 条里 message-like 不足 128 条）时窗口才会变短，可能导致个别已落盘消息被重复补尾。这属于现实中不会出现的病态分布，命中时打 `log.info`。
- **delivered**：`pushDelivered` 只保留最后 `DELIVERED_CAP`=512 个 key，新实现读 512 条，覆盖范围相同。差异只在分支有无 key 条目（compaction / branch_summary）时：旧实现会用更早的有 key 条目补满 512，新实现可能少几个。影响仅限 `/tree` 跳回很久以前时的 `diffAppended` 边界；旧实现超过 512 条时也有同类边界，属可接受偏差，写进 README。
- **对齐点**：仍然只认 `reply.leafId`（K7②）。leaf 之后追加的条目不在祖先链上，天然不会进结果。
- **wire**：`HistoryPayload` 字段不变。`source:"file"` 的出现比例会上升（>256 MiB 的文件），UI 不读这个值。

### 2.5 FileCache 的角色

snapshot 和 page **跳过 FileCache**。它只剩 `runTail` 的整文件回落在用（`readBranchTail` 返回 undefined 且文件 ≤256 MiB 时）。顺手加一条：`readBranchCached` 的 `:126` 改为只缓存 `size ≤ FILE_CACHE_MAX_BYTES (32 MiB)` 的索引。200 MB 文件解析后的索引约 1 GB 对象图；对 append-only 文件这份缓存几乎必 miss，却会一直驻留，是 RSS 尖峰的来源之一。

### 2.6 被否决的方案 B（按要求给出完整规格）

`readBranchTail` 的返回值改为 `{ ok:true; entries; chainContinues:boolean }`：

- `chainContinues` = 循环因 `out.length >= count` 退出，且 `cur !== null && !seen.has(cur)`。这样算是近似的：剩余祖先如果全是不投影的条目，会误报 true。要精确，就得在链上继续走到下一条可投影条目，可能超出当前块，触发块增长。
- 停止条件改为 `out.length >= count && messageLike >= need`。
- snapshot 调用 `readBranchTail(file, leaf, 512)`；`undefined` 时回落 `loadBranch`（文件 ≤256 MiB 就是整文件读）。

否决理由：见 §1 表格。核心是 32 MiB 预算一超就回落 7 s 整文件读；每轮整块同步 parse；与 page 共享不了游标。

### 2.7 测试（`tests/web-hub/hub/history.test.ts`）

**现有用例：无需修改，应原样通过**：

- `:501-578` snapshot 组：hasMore false / oldestEntryId `mc` / `tailEntries:3` / 文件不存在走 `branch_req` / leafId null / deadline。
- `:788`、`:850` 字节预算组：snapshot 读 512 条，再 `slice(-50)` 并截字节，断言不变。

探索报告预计 :190/:501/:731/:788 会受影响。逐条核对后，实际只有 §4.1 所列 readBranchTail 的签名/TOO_LARGE 两处要改。

**新增 `describe("snapshot ≡ full reader (reverse reader parity)")`**：参照值就地用 `readBranchFromFile` 加 `mergeSnapshot` 算出来，不需要导出新的纯函数。

- 场景：`fixtureLines()`；`bigSessionLines(2400)`（≈4.9 MB），leaf 取 EOF 处的 `m2399`、挂在 `m1800` 上的侧枝（祖先跨块）、挂在 `m3` 上的侧枝（祖先在文件头附近）；尾部 30 个 label；尾部半行；`tailEntries` ∈ {3, 400}；`recent` 长度 ∈ {0, 64}。
- 断言：`p.entries == full.slice(-T)`，`p.hasMore == full.length > T`，`p.oldestEntryId`，`p.tailMessages == mergeSnapshot(full, reply, []).tailMessages`，`p.source == "file"`。
- **hasMore 精确边界**：根端是 `label(parentId:null) → m0 → …`，`tailEntries` 恰好等于可投影条数 ⇒ `hasMore:false`（不开 parity 会是 true）。
- **祖先缺失算链尾**：中间某个 parent 行被删，结果等于 `walkBranch` 的截断链，`source:"file"`，不是 `branch_req`。
- **读量门禁**（operation-count）：通过 `readerStats` 断言 bigSession 尾部 snapshot 的 `stats.bytes < size/4`，`stats.yields ≥ 1`。
- **放宽的文档化**：文件头附近一行损坏，snapshot 仍然 `source:"file"`（旧实现会因 PARSE 走 agent）。
- **>256 MiB（稀疏文件）**：先 `truncateSync(file, DEFAULT_MAX_FILE_BYTES + (1<<20))`，再在末尾追加 `"\n" + bigSessionLines(600)`，链完全落在尾部。断言 snapshot `source:"file"`，`stats.bytes ≪ 32 MiB`。这条直接证明 P1 的悬崖已拆（以前是 TOO_LARGE → agent）。
- **busy 回落**：注入一个永远 pending 的扫描不现实，改用 `vi.useFakeTimers` 加一个已过期的子 deadline。更简单的做法是把子预算做成可注入参数，用 `snapshotFileBudgetMs: 0` 验证 → 走 `branch_req`，`source:"agent"`。

**`run-file-reader.test.ts` 新增 parity 组**（默认组一行不改，以此证明 run transcript 不受影响）：

- 精确 hasMore；祖先缺失 ⇒ done；环 ⇒ done；`cursorCacheSize` 生效；
- 同一批 fixture 下 parity=false 的结果与改动前逐字节一致：现有 T/P 组原样通过即为证明。

## 3 P0-page

### 3.1 游标设计

page 的语义是：当前 leaf 所在分支上，严格位于 `before` 之前的最多 `lim` 条。反向读取器的 `collect`（`run-file-reader.ts:215-235`）本来就是这个语义：在 newest-first 的链上定位 `before`，从它后一位开始取，受 limit/maxBytes 约束，再反转成从旧到新。所以：

- **游标**：用读取器自带的游标，key 为 `(realpath, size, mtimeMs, leafId)`。leaf 取 `view.status?.leafId ?? view.session?.leafId`（与现状 `:719` 相同）。不新增游标 wire 字段，浏览器仍然只传 `before=oldestEntryId`。
- **与 snapshot 衔接**：leaf 相同且其间没有 append 时，snapshot 已经把链读到 ≥513 条，第一页的大部分直接从缓存切出来，再从上次停下的 offset 续扫（P5 语义）。
- **活会话 append 之后**：size/mtime 变了，key 跟着变，从 EOF 重扫到 `before`。代价约等于 (距离 + lim) 条的投影，按 0.134 ms/条（4100 ms / 30,566）估算，深度 2000 条时约 270 ms，而且是协作式的。可以在 append 后把游标 rebase，见 §8 后续项。

### 3.2 改动点（`history.ts` `page()` `:715-750`）

```ts
const deadlineAt = Date.now() + Math.max(0, remaining() - 250); // 留 250 ms 余量，让 busy 先于外层 E_DEADLINE 返回
const r = file === undefined ? undefined
  : await branchReader.read(file, leaf, { before: beforeEntryId, limit: lim, maxBytes: MAX_HISTORY_PAYLOAD_BYTES, deadlineAt });
if (r?.ok) → entries = r.entries; more = r.hasMore; source = "file"
else if (r?.reason === "busy") → throw new HubError("E_BUSY")       // 503 → UI page_failed，可重点；游标进度保留
else → 现有 agent 路径（loadFromAgent + findIndex(before) + slice，找不到则 E_NOT_FOUND）
```

- **字节预算**：`maxBytes: MAX_HISTORY_PAYLOAD_BYTES`。`collect` 的逐条计字节（无 `+1`，最新一条无条件保留）与 `capEntriesByBytes` 的语义逐字相同，之后仍由 `buildCappedHistoryPayload` 按真实 JSON body 截断（`:925` 用例覆盖）。hasMore = `r.hasMore || candidateEntries.length < r.entries.length`。
- **`leaf_missing` 有两层含义**：一是 leaf 不在文件里，二是 `before` 不在已扫完的分支上。两种都回落 agent 路径，最终结果与现状相同（找不到就 E_NOT_FOUND）。代价是无效游标会多一次 `branch_req` 往返（P1② 之后很便宜）。不为此扩充 `RunFileReadFailure` 联合类型（那会动到 `run-transcript.ts:93` 的映射）。
- **单飞/并发**：完全复用读取器：同 key 并发的 page/snapshot 共享同一个扫描，history 实例内最多 2 个扫描，排队受各自 deadline 约束，超时返回 `busy`。
- **deadline**：外层仍是 `withDeadline(TIMING.snapshotMs)` 加 http 的 `HISTORY_GUARD_MS`，读取器 deadline 比外层早 250 ms。

### 3.3 测试

- 现有 `:731` page 用例原样通过：`page(u2,2)`、`page(u1,400)` 得到 `hasMore:false`、`"nope"` → E_NOT_FOUND（fake agent 的 branch 为 `[]`，`findIndex` 返回 -1）。
- 现有 `:828`、`:925` 字节预算用例原样通过。
- **新增 page 等价性**：在 `bigSessionLines(2400)` 上随机取 50 个 `before`，`lim` ∈ {1, 7, 400}，断言 `entries == full.slice(max(0,idx-lim), idx)`，`hasMore == idx-lim > 0`，`oldestEntryId` 正确。
- **游标衔接**：snapshot 之后 `page(oldestEntryId, 100)`，`readerStats.rounds` 至多加 1，且 `stats.bytes` 增量 ≪ 从 EOF 重扫的量。
- **append 后重扫正确**：snapshot 后 append 一行、leaf 前进，再翻页结果仍正确（key 变了，自然重扫）。
- **busy**：并发门占满（两个慢扫描），再发 page 并给极短 deadline，得到 E_BUSY；释放后重试成功。

## 4 P1

### 4.1 ① tail 路径不受 `maxFileBytes` 约束

- `readBranchTail`（`history.ts:149-241`）：删除 `:168` 的 `if (size > maxFileBytes) return TOO_LARGE`。它的读量本来就由 `TAIL_CHUNK_MAX_BYTES`（单次 32 MiB，总计约 42 MiB）封顶，和文件大小无关。
- 签名改为 `readBranchTail(file, leafId, count, opts?: { onRead?: (bytes:number)=>void })`，去掉 `maxFileBytes` 位置参数，免得留一个已经没有含义的参数。需要更新的调用点：`runTail` `:566`；测试 `:206/:215/:225/:272`（`undefined, onRead` 改成 `{ onRead }`）。返回类型里的 `TOO_LARGE` 从此不会出现。docblock `:131-148` 里「ENOENT / TOO_LARGE / LEAF_NOT_FOUND keep the full reader's exact meaning」改成「ENOENT / LEAF_NOT_FOUND」。
- snapshot/page 改用反向读取器之后，它们只受「从 EOF 累计扫描 256 MiB」约束，不受文件大小约束（§2.3）。
- **测试**：`:277-283` 的 `it.each` 去掉「file over maxFileBytes ⇒ TOO_LARGE」，换成「>256 MiB 稀疏文件，链在尾部 ⇒ ok 且等于末尾 64 条，读量 = 1 块」（用 §2.7 同款稀疏文件构造）。

### 4.2 ② agent 侧 `buildBranchReply` 改为反向投影、预算满即停（`agent/snapshot.ts:45-66`）

```ts
const kept: WireEntry[] = [];
let used = 0,
  truncated = false;
for (let i = raw.length - 1; i >= 0; i--) {
  const e = projectSessionEntry(raw[i]);
  if (e === undefined) continue;
  const size = Buffer.byteLength(JSON.stringify(e), "utf8") + 1;
  if (used + size > budget) {
    truncated = true;
    break;
  }
  used += size;
  kept.push(e);
}
kept.reverse();
return { t: "branch_reply", rid, entries: kept, truncated };
```

**2 MiB 裁尾语义逐字节保持**：

- 旧实现先全量投影，再从最新往回、遇到第一条放不下的就 break；`truncated = start > 0`。
- break 只会发生在一条**已投影**条目上，这时必然存在比 `start` 更旧的已投影条目，所以 `truncated` 为 true，与新实现在同一位置 break、置 `truncated=true` 等价。
- 循环自然结束时两者都为 false。
- 边界：budget=0 且分支非空，两者都是 `entries:[]`、`truncated:true`；投影结果为空时，两者都是 `[]`、`false`。
- 计字节都是 `+1`。
- `getBranch()` 本身是 pi 内存里的 O(n) 指针遍历，代价不大；投影（`canonicalJson`）才是贵的，现在只投影预算内那段约 2 MiB 加 1 条。

**测试**（`tests/web-hub/agent/snapshot.test.ts:144` 组）：

- 现有两条原样通过。
- 新增等价性：测试内保留旧实现作为 reference（逐字拷贝），用种子随机生成 200 个分支（混入 session 头、label、custom、超大消息），budget 取 {0, 1, 200 KiB, 2 MiB, 8 MiB}，断言 `buildBranchReply` 的结果与 reference 深度相等。
- 新增操作数门禁：`getBranch()` 返回一个计数 Proxy 数组（10,000 条，每条约 60 KiB 文本），断言被读取的下标数 ≤ 保留条数 + 1 + 被跳过的不投影条数，远小于 10,000。

不改动：`agent/run-transcript.ts:282` 那条 live run 的整枝投影也有同类问题，但不在本次范围，记入 §8。

### 4.3 ③ `runTail` 遇 TOO_LARGE 不再静默（`history.ts:553-594`）

有了 ① 之后，`runTail` 里的 TOO_LARGE 只会出自整文件回落（`readBranch`，`:566` 右侧）。触发条件是：文件 >256 MiB，并且尾读答不了（祖先在 EOF 前 32 MiB 之外、leaf 未落盘、块内有坏行）。

- **行为**：`:570` 的条件改为 `res.reason === "ENOENT" || res.reason === "TOO_LARGE"`，两种情况都走 `readTailFromAgent(agentKey, leaf)`。它的预算是 256 KiB，并且按 leaf 截断；leaf 不在回复里时返回 undefined，等下一次 leaf 变化再重试。语义与 ENOENT 回落相同。P1② 之后 agent 侧只投影约 256 KiB，不会把 4 s 的阻塞转嫁过去。
- **上报**：写 `log.warn("runTail: session file over the full-read cap and the tail could not answer; using the agent branch", { agentKey, reason: "TOO_LARGE", maxFileBytes: DEFAULT_MAX_FILE_BYTES })`，进 hub.log。只记元数据，不带条目内容，符合 `cmd-history-runtail.test.ts:363` 的日志卫生要求。**按 agent 每段连续状态只打一次**：`AgentHist`（`:420`）新增 `tailTooLargeWarned: boolean`，打出后置 true；某次读成功（`res.ok`）时复位。这样不会每 500 ms 刷一条。
- **不新增 wire 帧**：「不再静默」指运维能在 hub.log 里看到，并且实时 append 继续走 agent 通路。
- **契约变更（刻意为之）**：`cmd-history-runtail.test.ts:273-318` 钉住的「TOO_LARGE / PARSE / LEAF_NOT_FOUND 早退、不发 branch_req」中，TOO_LARGE 这一项要改：期望变为发出 1 个 `branch_req`、产生 1 次 append、1 条 warn；连续两次 leaf 变化仍只有 1 条 warn。PARSE / LEAF_NOT_FOUND 两个子用例不动。需要同步更新：`history.ts:470-492` readTailFromAgent docblock 的「ENOENT-only」、README `:330`「ENOENT-only」、`docs/dev/web-hub-cmd-history/H1-report.md` 里相应描述（追加一行变更说明，不改历史结论）。

## 5 风险与回退

| #   | 风险                                                                                 | 处置                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **行内嵌换行导致切行误判**                                                           | JSON.stringify 会把字符串内的换行转义成 `\n`（两个字节），UTF-8 多字节序列里也不会出现 0x0A，所以 0x0A 只会是记录分隔符。反向读取器按字节切行，跨块的半行和被切开的 UTF-8 都拼回原始字节后才解码（已有测试 `run-file-reader.test.ts:299`）。CRLF：`JSON.parse` 能容忍尾随 `\r`。非 pi 写入的 pretty-print 文件，整文件读本来也是 PARSE；反向读会因预滤 miss 判成 leaf_missing，再走 `branch_req`，结果正确，只是来源变成 agent |
| R2  | **预滤依赖紧凑格式 `"id":"<x>"`**                                                    | pi 用 JSON.stringify 写入，run transcript 线上已依赖这一点。不匹配时只会漏判（变成 leaf_missing → agent），不会误判，因为命中后还要 `JSON.parse` 并确认 `id === want`                                                                                                                                                                                                                                                          |
| R3  | **mid-read 时切分支**（`/tree`）                                                     | snapshot 只认 `reply.leafId`，同 tick 读取；文件读不受之后的导航影响，导航后由 `status` → `runTail` 的 diff 或 `gap` 接管（与现状相同）。page 在请求开始时取一次 leaf（与现状 `:719` 相同）；导航后旧游标的 key 含旧 leaf，不会被误用                                                                                                                                                                                          |
| R4  | **mid-read 时 session 切换**                                                         | snapshot 现有的 `states.get(agentKey) === st` 守卫保留；`session` 事件仍会清空 delivered。page 在开始时取 `file`，结果属于旧会话；浏览器在 session 切换时会重新 snapshot（D2-7 守卫），旧页被丢弃                                                                                                                                                                                                                              |
| R5  | **并发 append 时的读一致性**                                                         | 读取器在开始时 stat，只扫 `[0, size)`；之后追加的字节对本次读不可见（`run-file-reader.ts` 头注「Snapshot semantics」，测试 `:387`）。snapshot 的 leaf 由 agent 先读，pi 同步落盘后它已在 `size` 之内。并发 append 只会让下一次读换 key 重扫                                                                                                                                                                                    |
| R6  | **文件被重写或截断**（pi 迁移、外部改动）                                            | 读到短块或乱序字节，会得到 `parse_error` / `leaf_missing`，再走 `branch_req`；下一次读换 key 重扫。不会挂起：每块都检查 deadline                                                                                                                                                                                                                                                                                               |
| R7  | **重复 id**（损坏文件）                                                              | 整文件读对重复 id 取全文件最后一次出现；反向读取的是 child 位置之前最近的一次出现。只有「重复 id 的后一份写在 child 之后」时两者才会不同，健康的 append-only 文件里不可能发生；环由 parity 规则判为链尾。写进 README 残留风险                                                                                                                                                                                                  |
| R8  | **leaf 未落盘时扫完整个文件**                                                        | 预滤扫描 190 MB 是协作式的，约 0.5–1 s，受 2.5 s 子 deadline 约束，到期返回 busy → `branch_req`，总时长仍在 5 s 内。旧实现的整文件读要 7 s，而且同步卡死                                                                                                                                                                                                                                                                       |
| R9  | **超长单行或无换行区域**（如稀疏区）让 `rest` 反复 `Buffer.concat`，复制量呈二次增长 | 这是读取器原有的问题。snapshot 只读尾部不会碰到；page 深扫时受 deadline（4.75 s）和 `maxScanBytes` 封顶，返回 busy / too_large。记为残留，后续可加 `maxLineBytes`                                                                                                                                                                                                                                                              |
| R10 | **游标内存**                                                                         | 每个游标持有已投影的链：snapshot 约 512 条，本例约 1.5 MB；深翻到底约等于整枝投影（本例几十 MB）。上限是 LRU 8 × 链。即便如此也远低于现状 1.6 GB 的峰值。写入 README                                                                                                                                                                                                                                                           |
| R11 | **`TIMING.snapshotMs` 定时器跑不到**                                                 | 读取器每块让出一次，定时器能按时触发，「形同虚设」问题自然消失                                                                                                                                                                                                                                                                                                                                                                 |
| R12 | **delivered 基线的边界偏差**（§2.4）                                                 | 只影响含无 key 条目的分支在 `/tree` 远跳时的 diff 边界，与 >512 条时的现有边界同类，写进 README                                                                                                                                                                                                                                                                                                                                |
| R13 | **回退**                                                                             | 每包一个 commit（§7 顺序）。P0 回退等于 revert 对应 commit，因为 `readBranchCached` / `walkBranch` 保留不删（`runTail` 回落和 `readBranchFromFile` 仍在用）。紧急止血时也可以一行切回：`loadSnapshotBranch` 里保留 `readBranch` 调用的旧分支直到评审通过。不加 settings 开关：这是纯性能修复，wire 不变，I9 不适用                                                                                                             |

## 6 验收口径

### 6.1 CI（必须绿，进 `npm test`）

1. 等价性：§2.7、§3.3、§4.2 的 parity / 等价组。
2. **新增 `tests/web-hub/hub/history.perf.test.ts`**，仿照 `run-file-reader.perf.test.ts`：
   - 构造约 48 MB 合成会话：2,600 条约 16.5 KB 的 `custom` archive 状态（多键嵌套对象，覆盖 `canonicalJson` 这个热点），与 message 交错且都在链上；leaf 在 EOF。
   - `createHistoryService` + fake agent 跑 `snapshot()`，并发跑 setImmediate 探针。门禁：耗时 <1000 ms（本地预期 <100 ms；CI 留余量，只防回归），事件循环最大间隔 <100 ms，`readerStats.bytes < size × 0.25`。
   - 同一测试顺带跑一次 `readBranchFromFile` 计时，只 `console.log` 比值（不做门禁），留作证据。
   - `page(oldestEntryId, 400)` 门禁：<500 ms，`rounds` 增量 ≤1。
3. 稀疏 >256 MiB 用例（§2.7 / §4.1 / §4.3）是悬崖已拆的门禁。
4. `git diff --quiet origin/dev -- tests/fixtures/` 必须为真（不碰 golden）。

### 6.2 本地实测（对应探索报告的四个数字，在原会话 `a1556874-vDjp6f`、`/webhub restart` 后测）

| 指标                            | 目标                                               | 测法（与探索报告同构）                                                                                                     |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 进详情页到首条 `.tx-item`       | <300 ms（原 7,394）                                | playwright 真实浏览器：从 `page.goto` 详情页起计时，到 `waitForSelector('.tx-item')`；取 3 次中位数，对照 warren（原 251） |
| subscribe 到 history 帧         | <150 ms（原约 7,000）                              | 浏览器端 SSE 时间戳，或 hub.log 审计行；3 次                                                                               |
| 快照进行中的 `GET /api/version` | <50 ms（原 5,746）                                 | `curl -w '%{time_total}'` 循环（每 20 ms 一次），同时触发 subscribe，取期间最大值                                          |
| hub RSS                         | 无 GB 级尖峰（原 559 MB → 1.61 GB，VmHWM 2.66 GB） | 测前 `/proc/<hubpid>/status` 记 VmRSS/VmHWM；连续 5 次 subscribe 加 10 次 Show earlier，再采样；要求 VmHWM 增量 <200 MB    |
| 附加：Show earlier              | 第 1 页 <100 ms，第 10 页 <500 ms                  | `curl /api/history?agent=…&before=…&limit=100`                                                                             |

记录结果写入 `docs/dev/web-hub/refresh-slow/acceptance.md`（由验收者产出）。

## 7 改动文件清单与实施顺序

| 包     | 文件                                            | 改动                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 底座 | `src/web-hub/hub/run-file-reader.ts`            | `fullReaderParity` / `cursorCacheSize` opts；注释更新（`scanChunkBytes`）                                                                                                                                                                             |
|        | `tests/web-hub/hub/run-file-reader.test.ts`     | 新增 parity 组                                                                                                                                                                                                                                        |
| ② P0   | `src/web-hub/hub/history.ts`                    | 常量；服务内的 `branchReader`；`readTailForSnapshot` / `loadSnapshotBranch` / `loadFromAgent`；`snapshot()` hasMore；`page()` 改用反向读；`dispose`；FileCache 只缓存 ≤32 MiB；头注更新                                                               |
|        | `tests/web-hub/hub/history.test.ts`             | 新增 snapshot/page 等价、读量、稀疏文件、busy、衔接用例                                                                                                                                                                                               |
|        | `tests/web-hub/hub/history.perf.test.ts`（新）  | 性能门禁                                                                                                                                                                                                                                              |
| ③ P1   | `src/web-hub/hub/history.ts`                    | `readBranchTail` 去掉 size 门和 `maxFileBytes` 参数（改成 opts）；`runTail` TOO_LARGE → agent + 一次性 warn；`AgentHist.tailTooLargeWarned`                                                                                                           |
|        | `src/web-hub/agent/snapshot.ts`                 | `buildBranchReply` 改为反向投影                                                                                                                                                                                                                       |
|        | `tests/web-hub/hub/history.test.ts`             | readBranchTail 调用点改为 `{onRead}`；TOO_LARGE 行改为稀疏文件 ok                                                                                                                                                                                     |
|        | `tests/web-hub/hub/cmd-history-runtail.test.ts` | `:273` 的 TOO_LARGE 子用例改为回落 + warn 一次                                                                                                                                                                                                        |
|        | `tests/web-hub/agent/snapshot.test.ts`          | 等价性（reference）+ Proxy 操作数门禁                                                                                                                                                                                                                 |
| ④ 文档 | `docs/dev/web-hub/README.md`                    | 重写 `:345-365`「History tail reads」：主线程规则扩展到 snapshot/page；反向读取器、parity、回落矩阵、放宽项（分支外坏行）、残留风险 R7/R9/R10/R12；删除「snapshot()/page() still use the full reader」。`:330`「ENOENT-only」改为「ENOENT/TOO_LARGE」 |
|        | `docs/dev/web-hub-cmd-history/H1-report.md`     | 追加 §4.10 边界变更说明                                                                                                                                                                                                                               |

顺序：① → ② → ③ → ④。①② 必须串行（② 依赖 ① 的 opts）。③ 里的 agent 侧（snapshot.ts）与 ①② 无依赖，可以并行派发。每包交回后由验收者跑 `format:check → typecheck → test`；②③ 还要跑 perf 测试。
提交类型：①② 用 `perf(web-hub)`，③ 用 `fix(web-hub)`，④ 用 `docs(web-hub)`。

## 8 后续 / 开放问题（不在本次范围）

- **游标 rebase**：append 后，若新 leaf 往回走能在旧游标的 `visited` 里碰到某个交汇点 J，且 `before` 在 J 之后，就把新增段和旧链拼起来，沿用旧 offset/rest。这样深翻页在活会话上能从 O(深度) 降到 O(新增)。等实测第 10 页如果超过 500 ms 再做。
- **`runTail` 在大文件上回落整文件读**：文件 ≤256 MiB 且尾读答不了时，仍然会同步读整文件，例如 `/tree` 跳回很早的节点，最长约 7 s。可以改成先走反向读取器，但会改变 PARSE / LEAF_NOT_FOUND 的现有钉子（`cmd-history-runtail.test.ts:273`）。建议作为 #89 之外的单独小任务，需用户拍板。
- `agent/run-transcript.ts:282` 的 live run 整枝投影：与 P1② 同类，可以复用同样的反向写法。
- `canonicalJson` 对 archive 条目的投影成本（2.6 s/5524 条）：随 P2（#89 写入去重）一起处理更合适。
