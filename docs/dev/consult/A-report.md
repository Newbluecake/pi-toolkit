# Package A — Phase 1 frozen face

日期：2026-10-18。状态：实现与自验通过；**未提交 commit**。按 `cache-thread-plan.md` v2 + §R1/§R2；P0 已通过，全部锚点字段保留。范围仅 core 类型、reducer、journal、request-threading 及对应测试；没有运行时或 UI 消费者。

## 1. 用户裁定与澄清

- **2026-10-18 14:00 用户裁定：豁免 tombstone 保留。** “Exactly like the other consult diag fields” 是规则：`consults` / `experts` / `dispatchMeta` 不进 tombstone，新 `consultCache` / `consultThread` 同样不进；保留于终态条目、非终态 journal、终态重建。**没有修改 `src/service/tombstone.ts`。**
- 询问了方案作者 `r_26AM5048`：探针的 `anchor` 是放置状态，不是完整 `AnchorIdentity`；可信哈希留在进程内 prefix record / thread / ledger。预判证据只持久化来源、TTL 和证实时间，不保存哈希或凭据。
- 字段拼写服从 R2-4 / §9：consult 自身为 `diag.consultThread.{threadId,seq}`；asker 探针为 `cacheProbes[].thread.{id,seq}`，二者由 C 从同一线程事实投影。没有以作者建议覆盖 R2。
- 首结果 reducer 规则与作者核对：generation 检查之后、终态分派之前处理；只在已有 enqueue 预测的非终态运行写一次；不刷新心跳、不发 effect。

## 2. 精确冻结类型

下列均导出自 `src/core/types.ts`（省略说明注释，字段与代码一致）：

```ts
export interface AnchorIdentity {
  k: number;
  block: number;
  blockType: "text" | "tool_use" | "tool_result" | "image";
  blockHash: string;
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  route: { provider: string; model: string; api: string };
  ttl: string | "";
}

export interface ConsultAnchorSpec {
  prompt: string;
  base?: AnchorIdentity;
}

export type ConsultAnchorStatus = "added" | "relocated" | "n/a" | `skipped:${string}`;

export interface ConsultCacheResult {
  v: 1;
  readShare: number | null;
  label: "hit" | "partial" | "miss" | "n/a";
  anchor: ConsultAnchorStatus;
  degraded?: true;
}

export interface ConsultWarmPrediction {
  state: "warm" | "cold" | "unknown";
  reason?: string;
  evidence?: {
    source: "anchor-ledger" | "keepalive" | "expert-settle";
    ttlMs: Millis;
    lastProvenTouchAt?: Millis;
    settledAt?: Millis;
  };
}

export interface ConsultThreadRef {
  threadId: string;
  seq: number;
}

export interface ConsultCacheDiagnostics {
  v: 1;
  predicted: ConsultWarmPrediction;
  first?: ConsultCacheResult & { at: Millis };
}
```

既有接口/联合上的新增字段如下；其它既有字段保持原样：

```ts
// SpawnRequest AND SessionSpec:
consultAnchor?: ConsultAnchorSpec;

// RunDisplayMeta (deliberately cannot seed first):
consultCache?: Pick<ConsultCacheDiagnostics, "v" | "predicted">;
consultThread?: ConsultThreadRef;

// RunDiagnostics:
consultCache?: ConsultCacheDiagnostics;
consultThread?: ConsultThreadRef;

// DriverEvent union member (timestamp comes from outer RunInput.at):
| { t: "consult_cache_first"; result: ConsultCacheResult }
```

`src/core/consult-summary.ts` 的 `ConsultCacheProbe` 新增字段：

```ts
anchor?: { state: ConsultAnchorStatus; ttl?: string; degraded?: true };
thread?: {
  id: string;
  seq: number;
  mode?: "continued" | "new" | "fresh" | "reset" | "pending" | "branch";
  reason?: "context" | "cost" | "size" | "budget" | "seq-cap" | "identity";
};
cacheResult?: ConsultCacheResult;
warm?: ConsultWarmPrediction & { pingsSince?: number; pingUsdSince?: number };
```

语义约束：`seq` 为 1-based；`thread.reason` 仅用于 reset；`pending` 对应“上一答尚未保留”；`anchor.ttl` 无显式 TTL 时省略，`AnchorIdentity.ttl` 则为 `""`。已知 skip 原因为 `shape|block|identity|limit`，类型按 §5.2 保持开放的 `skipped:${string}`。Phase 1 不实现 ping；两个 Phase 2 计数可省略。

### Metric 纯函数

新增导出自 `src/core/consult-summary.ts`：

```ts
export function classifyConsultCacheResult(
  first: Pick<UsageDelta, "input" | "cacheRead" | "cacheWrite"> | undefined,
  anchor: ConsultAnchorStatus,
  degraded?: true,
): ConsultCacheResult;
```

- 输入必须是**首个真实 provider 请求**的计数，不是含 keepalive 的累计 `diag.usage`。
- `readShare = cacheRead / (cacheRead + cacheWrite + input)`；`>=0.80 hit`，`>=0.20 partial`，其它 `miss`。
- 无请求、总量为零、负数/非有限数或总量溢出：`readShare:null,label:"n/a"`；不会产生 NaN/Infinity。
- `anchor` / `degraded` 原样携带，不干预实测标签；`degraded` 缺席时没有该键。
- 旧 `hitRatio` 与执行 `outcome` 不改。F0 的 64,186 / 272,683 判为 partial。
- classifier → `foldConsultCall` → `foldConsultCacheProbe` 的既有原子路径完整保留新字段，FIFO 上限仍为 8；不从实测回填预判，也不推断旧探针缺失字段。

## 3. Reducer 规则

| 输入/前提                                                          | 结果                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 首次合法 enqueue，meta 有 consultCache                             | 只投影 `{v,predicted}`；拒绝通过额外未类型化字段预种 `first` |
| 首次合法 enqueue，meta 有 consultThread                            | 写入 consult 自身 `{threadId,seq}`；独立于 asker 环          |
| enqueue 无上述 meta                                                | 不创建对应键；无默认 unknown/空对象                          |
| 重复 enqueue                                                       | 既有非法输入规则；预测/线程不变                              |
| 首个同 generation `consult_cache_first`，非终态且已有 consultCache | 写 `first = {...result, at: input.at}`                       |
| 重复 first                                                         | 引用相等 no-op，保留最早值和时间                             |
| 没有 enqueue 预测的 first                                          | 引用相等 no-op；普通/旧 run 不产生新字段                     |
| 终态 first（completed/failed/timed_out/aborted）                   | 引用相等 no-op；已封存 outcome 不变                          |
| stale-generation first                                             | 沿既有 generation gate 仅增加 staleInputs，不抢占 first      |

首结果事件**只改变 `diag.consultCache.first`**，不改 status/phase/phase clocks、lastEventAt/lastEventType、usage/turns、deadlines、timers、outcome，不发 effect。正常 message_end 独立承担用量与心跳语义。未新增 RunInput kind，因此原 12×14 生命周期矩阵保持 168 格，另外增加该 DriverEvent 的逐相位矩阵行与终态状态行。

## 4. 持久化矩阵

| 表面                                             | consultCache（预测/first）         | consultThread | asker cacheProbes 新字段     |
| ------------------------------------------------ | ---------------------------------- | ------------- | ---------------------------- |
| reducer live diag                                | enqueue + 首结果                   | enqueue       | consult tool_end fold        |
| outcome.diag / persist_snapshot / 终态 run entry | 保留                               | 保留          | 保留                         |
| session_created / shutdown_flush 非终态 journal  | 新白名单项，保留已有值             | 新白名单项    | 既有 consults 白名单整体保留 |
| interruptedFromJournal                           | 保留到 aborted diag + outcome.diag | 保留          | 保留                         |
| pi run-log JSON 往返 / fresh store seed          | 保留                               | 保留          | 保留                         |
| SpawnService 从 outcome.diag 终态重建            | 既有整体复制保留                   | 同左          | 同左                         |
| tombstone                                        | **不保留：用户裁定豁免**           | **同左**      | 与原先一致，不保留           |
| 旧/普通运行，从未设置                            | 键缺席                             | 键缺席        | 新探针字段不补写             |

`consultAnchor` 是临时 adapter→SessionSpec 接缝：NOT_THREADED，不进入 ResolvedSpawnRequest、子 prompt、journal 或 resume 继承。A 没有增加任何字段读取/运行时安装；B 负责明确透传至 SessionSpec，不可用 threading 绕过这个边界。

## 5. 测试与自验实录

新增/扩展断言：

- `tests/core/core.test.ts`：每个 RunPhase 的首结果矩阵（有/无预测、重复），四种终态；综合随机生成器加入事件。
- `tests/core/consult-cache-diag.test.ts`：写一次、timestamp 来源、防 metadata 注入、stale、普通/旧 run 缺席；固定 seed `0xca4e` 的 200 次随机序列，不变量覆盖所有分支且有非空覆盖计数。
- `tests/core/consult-summary.test.ts`：0.80/0.20 阈值及邻界、零分母/无请求、非法计数、degraded、执行结局独立、全部新字段 fold/FIFO、旧探针兼容。
- `tests/core/run-journal.test.ts`：精确白名单/缺席/重建检查加入新字段。
- `tests/core/consult-cache-persistence.test.ts`：真实 reducer terminal effect、run-log JSON 往返、seed、journal→interrupted、SpawnService terminal rebuild；预测-only/完整/旧字段三种形状。
- `tests/service/request-threading.test.ts`：fork 和 resume 两条输入都不传 anchor，sentinel/hash 不泄漏、prompt 不变；原编译穷尽门测试仍通过。

实际命令输出（摘录末尾，完整日志见 `/tmp/consult-A-*.log`）：

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.5.5 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
EXIT_CODE=0

$ timeout 900 npx vitest run tests/core tests/service tests/consult tests/runtime
 Test Files  99 passed (99)
      Tests  1829 passed (1829)
   Start at  14:05:41
   Duration  24.99s
EXIT_CODE=0

$ timeout 280 npm run build
> pi-toolkit@0.5.5 build
> tsc -p tsconfig.build.json
EXIT_CODE=0
```

格式检查（下列精确 13 个文件；退出码 0）：

```sh
timeout 60 npx prettier --check src/core/types.ts src/core/state-machine.ts src/core/consult-summary.ts src/core/run-journal.ts src/service/request-threading.ts tests/core/core.test.ts tests/core/run-journal.test.ts tests/core/consult-summary.test.ts tests/core/consult-cache-fixtures.ts tests/core/consult-cache-diag.test.ts tests/core/consult-cache-persistence.test.ts tests/service/request-threading.test.ts docs/dev/consult/A-report.md
```

```text
Checking formatting...
All matched files use Prettier code style!
EXIT_CODE=0
```

## 6. 交付文件（绝对路径）

1. `/home/bluecake/ai/pi-toolkit/src/core/types.ts`
2. `/home/bluecake/ai/pi-toolkit/src/core/state-machine.ts`
3. `/home/bluecake/ai/pi-toolkit/src/core/consult-summary.ts`
4. `/home/bluecake/ai/pi-toolkit/src/core/run-journal.ts`
5. `/home/bluecake/ai/pi-toolkit/src/service/request-threading.ts`
6. `/home/bluecake/ai/pi-toolkit/tests/core/core.test.ts`
7. `/home/bluecake/ai/pi-toolkit/tests/core/run-journal.test.ts`
8. `/home/bluecake/ai/pi-toolkit/tests/core/consult-summary.test.ts`
9. `/home/bluecake/ai/pi-toolkit/tests/core/consult-cache-fixtures.ts`
10. `/home/bluecake/ai/pi-toolkit/tests/core/consult-cache-diag.test.ts`
11. `/home/bluecake/ai/pi-toolkit/tests/core/consult-cache-persistence.test.ts`
12. `/home/bluecake/ai/pi-toolkit/tests/service/request-threading.test.ts`
13. `/home/bluecake/ai/pi-toolkit/docs/dev/consult/A-report.md`

## 7. B / C / U / F 接棒

- **B**：adapter 显式读 `SpawnRequest.consultAnchor` → `SessionSpec.consultAnchor`；只在 consult fork 安装。按 §3.2 全量复核可信 identity；prefix record 保存 identity，探针仅保存状态。首个真实 assistant message_end 与首请求配对后，用 `classifyConsultCacheResult` 构造并发 `consult_cache_first`；不能把 ping 用量混入。无首请求时展示端可视为 n/a，不伪造事件。
- **C**：生成 `{v:1,predicted}` 与 `{threadId,seq}`，通过 runtime adapter 的 RunDisplayMeta 送 enqueue；不要将这些额外数据塞进 child prompt。ledger 按 §5.1 identity key 绑定 route/system/tools/prefix，5m 或已证实 1h TTL 与 15s 安全余量，证据不足 unknown。warm 是开始时的预测，不能由首响应覆盖；probe 的 warm 与 enqueue 预测来自同一事实。保持 §4.1 的 `(askerRunId,expertRunId)` key，main 不建线程；R2 gen/disposed/预算栅栏属于 C，不属于 A。
- **U**：从 consult **自身** `diag.consultThread` 读分组与 `t#n`，不依赖 asker 八项环或 fork 文件还存在；`diag.consultCache.predicted` + `first` 是展示事实，缺席须兼容旧运行。紧凑 marker 用英文 token；不要调用 ledger/keeper。
- **F**：从 `cacheResult.v === 1` 的 readShare/label 做新分组，未知 metric 版本跳过；不要改用旧 hitRatio 或执行 outcome。线程探针键为 `thread.id`，run 自身键为 `consultThread.threadId`。保留旧数据缺字段分支。

## 8. 遗留与收尾

A 无已知实现阻塞。B/C/U/F 的运行时、线程生命周期、生产安装链 conformance、UI 与分析脚本均未在本包实现；Phase 2 keepalive/usage_accrued 不在范围。并行 feishu/markdown 文件未触碰；无新依赖、无 pi imports 进入 core、无 timer/await、无 commit。

## Verification (r_C8NTESHD, Sonnet — pass, 0 blockers)

Hand-off reminders from the verifier (no rework for A):

- **C must write `predicted` for every consult run** (main, no evidence, OAuth ⇒ `{state:"unknown"}`); a consult run without an enqueue-time `consultCache` silently drops `consult_cache_first` by design. C adds a test for it.
- **One thread fact, two projections**: the probe's `thread.{id,seq}` and the consult run's own `diag.consultThread.{threadId,seq}` must be projected from the same source in B/C.
- **`first.at` is the dispatch time of `consult_cache_first`**, not the request start: B emits it right after the first assistant `message_end`; F must not treat it as request time.
