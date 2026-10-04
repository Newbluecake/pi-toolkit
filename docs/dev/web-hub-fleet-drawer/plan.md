# web-hub 右侧 fleet 抽屉 + subagent transcript 通道 — 实施方案

> 状态：方案（待评审）。范围：web 端 fleet 从「顶部浮层」改成「右侧抽屉」，抽屉里放 fleet 树和选中子 agent 的
> transcript，子 agent 运行中尽量 live。用户已经拍板「抽屉和 transcript 通道绑在一起一次做完」。
> 本文只读代码写成，没有改任何实现。行号以 `2885be1` 为准。

---

## 0. 结论摘要

| 决策点              | 结论                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通道形态            | **混合**：按需拉取（快照 + 分页），打开抽屉选中某个 run 之后才订阅 live；没人看就不推                                                                                                                                        |
| 运行中 run 的数据源 | **agent 进程内**：子 `AgentSession` 本来就跑在父 pi 进程里（`session-driver.ts:653/680` 的 `createAgentSession`），快照读内存里的 `sessionManager.getBranch()`，live 用 `session.subscribe()` 挂一个按 run 区分的 `EventTap` |
| 已终态 run 的数据源 | **hub 读盘**：agent 只回 `sessionFile` 路径，由 hub 异步读 jsonl、按字节预算截尾部（复用 `hub/history.ts` 的文件索引、LRU 缓存和 `capEntriesByBytes`），不让 pi 事件循环同步解析可能几十 MB 的文件                           |
| 帧                  | agent↔hub 新增一族 `run_*` 帧（`run_tx_req`/`run_tx_reply`/`run_watch`/`run_ev`/`run_gap`/`run_end`）；**不扩展 `ev`，也不走 cmd op，不走 `/api/headless`**                                                                  |
| 浏览器面            | `POST /api/run/subscribe`、`POST /api/run/unsubscribe`、`GET /api/run/history`；SSE 新增 4 个**定向**事件 `run_history`/`run_ev`/`run_gap`/`run_end`，不进全局 replay ring                                                   |
| 兼容                | `PROTO` 升到 1.2（只加帧，major 不变）；真正的门槛是 agent 能力位 `runtx.v1` / `runtx.lan.v1` 加上 `AgentCard.runTranscript*`（与 upload 方案同一套门槛模式）                                                                |
| 关联键              | **`runId`**（`FleetRowWire.runId`，格式 `^r_[0-9A-HJKMNP-TV-Z]{8}$`，见 `src/core/ids.ts:10`）；label 只用于显示，不参与匹配（同 `core/types.ts:140-146` 的约定）                                                            |
| 布局                | 抽屉放在 `AgentDetail` 里面，不放在 `DashboardView` 层（`FleetActions` 依赖 `AgentDetail` 提供的 `CONTROL_CTX`）。三种模式：≥1280px 停靠第三栏；768–1279px 覆盖在主 transcript 上；<768px 全屏                               |
| 浮层去留            | 删掉 `FleetPanel.vue` 的浮层机制。树渲染抽到 `FleetTree.vue`，一行摘要变成 `FleetSummaryBar.vue`（抽屉开关）。`FleetNode`/`FleetActions`（steer/stop）原样保留，只加一个「查看 transcript」入口                              |

---

## 1. 现状核对（含对已有探查结论的修正）

### 1.1 已确认的事实

- fleet 行只有 14 个摘要字段：`FleetRowWire`（`src/web-hub/protocol/messages.ts:87-102`），由 `projectFleet`（`src/web-hub/agent/status.ts:57-90`）复用 TUI 的 `buildFleetViewModel` 投影出来，最多 64 个活跃 run 加 8 个最近终态 run（`status.ts:18-19`），1Hz tick 加指纹去抖（`agent/index.ts:327-331`、`status.ts:95-103`）。
- 子 agent 没有增量 transcript：fleet 的 `streamLine`/`toolTrail` 来自 `RunDiagnostics` 里三个裁剪过的环形缓冲（`core/types.ts:797/838/848`）。session 文件路径在 `RunDiagnostics.sessionFile`（`core/types.ts:850`），在 `session_created` 时写入（`runtime/runner.ts:689-696`）。
- 主会话 transcript 的通路：浏览器 `POST /api/subscribe` → hub `history.snapshot()`：先 `snapshot_req`，hub 再读 agent 报上来的 jsonl，按 leafId 对齐并 reconcile `recent`（`hub/history.ts:479-555`）→ SSE `history`（定向），之后是按 agentKey 作用域的 `ev`/`gap`/`append`（`hub/http.ts:657-697`、`:733-760`）。分页走 `GET /api/history`（`http.ts:798-815`，每页最多 400 条，`HISTORY_PAGE_MAX` 在 `:115`）。字节预算是 2 MiB（`LIMITS.branchReplyBytes`，`messages.ts:426`；单帧上限 4 MiB，`ndjson.ts:10`）。
- 先例：读不到文件时回退到 agent 内存：`branch_req`→`buildBranchReply`（`agent/snapshot.ts:39-62`），取 `getBranch()` 尾部、按字节预算截断。
- UI 侧：`DetailBody.vue:21-38` 是一个纵向 flex 列（`FleetPanel` 在上，`Transcript` 在下）。`Transcript.vue` 的 props 是整个 `AgentState`（`contracts.ts:252-256`），内部用 `buildTxEntries(agent)`（`entries.ts:176`）加窗口化（`useTranscriptWindow.ts`，挂载上限 300）。分页事件 `load-older` 一路冒到 `useHub.page()`（`useHub.ts:186-196`）。
- 060c33b 的浮层：`FleetPanel.vue:52-61/89-113` 用 `<details>` 加文档级 pointerdown/Escape 监听，`fleet.css:72-91` 的 `.tree-scroll` 用 `position:absolute; z-index:20; max-height:34dvh`。
- steer/stop：`FleetNode.vue:75-81` 注入 `CONTROL_CTX`，`FleetActions.vue` 调 `ctx.control.steerSub/stopSub`。`CONTROL_CTX` 由 `AgentDetail.vue:281-289` 提供。
- 断点：JS 侧 `narrow = (max-width: 767px)`（`DashboardView.vue:31`），CSS 侧 `.layout` 在 768/1025/1280 三档调整 `--sidebar-w`（`shell.css:165-192`）。目前没有第三栏的先例。
- localStorage 有白名单：`tests/web-hub/ui/source-scan.test.ts:62-66` 的 `LOCALSTORAGE_ALLOWED`。侧栏折叠的先例是 `AgentList.vue:58-89`（`COLLAPSE_KEY`、try/catch、CSS min-width 门控）。
- `rememberAgents:false` 时子会话是 `SessionManager.inMemory`（`session-driver.ts:652-653`，默认值 true 见 `config/settings.ts:673`），这类 run 根本没有文件。
- pi 的 `SessionManager._persist` 要等第一条 assistant 消息出现才落盘，之后按条目逐条 `appendFileSync`（`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:785-815`）。所以运行中的文件**在第一条 assistant 消息之前不存在**，之后也只在 `message_end` 这一级粒度上增长。

### 1.2 对探查结论的修正

1. 「跨进程 tail 正在被写的文件无先例」：**有先例**。hub 的 `runTail`（`history.ts:353-386`）就是跨进程读主会话文件尾部来补 `append`。但本方案**不采用**文件 tail 做 run 的 live，原因有三：(a) 子会话和父进程同在一个进程里，事件可以直接订阅，精度到 token 级；(b) 文件在首条 assistant 消息前不存在，`rememberAgents:false` 时永远不存在；(c) 文件 tail 只有消息级粒度，做不到「尽量 live」。
2. 「已终态 run 走 agent 侧磁盘读，照 `buildBranchReply`」：**改成由 hub 读**。`buildBranchReply` 读的是**内存**里的 `getBranch()`，不是磁盘。在 agent 侧同步读解析 46.9 MB 的 jsonl 会卡住父 pi 的 TUI 事件循环。hub 本来就有异步读、256 MiB 上限、realpath/`.jsonl`/普通文件校验（`history.ts:79-111`）和 4 项 LRU 索引缓存，信任模型也一样（路径只来自 agent，不来自浏览器，见 `history.ts:14-16`）。
3. 帧名：探查建议的 `child_branch_req/child_branch_reply` 改为 `run_tx_req/run_tx_reply`，另外补上 live 需要的 `run_watch/run_ev/run_gap/run_end`。语义还是「仿 `snapshot_req`/`branch_req` 的 rid 请求-应答」。

---

## 2. transcript 通道选型

### 2.1 候选

| 方案                  | 做法                                                                                                                            | 问题                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 纯推                | agent 把所有子 agent 的 delta 持续推给 hub，hub 广播                                                                            | N 个运行中 run × 每秒最多 20 帧 delta，推给所有浏览器（`sse.publish` 只按 agentKey 作用域，`http.ts:657-660`），而大多数时候没人看；还会占满 16 MiB 的全局 ring（`sse.ts:4-8`），挤掉主会话可补发的帧                   |
| B 纯拉                | 浏览器定时 `GET` 某个 run 的尾部                                                                                                | 做 live 只能轮询，每次重传整段尾部（最多 2 MiB），延迟和流量都差；流式文本根本拿不到（文件里没有）                                                                                                                      |
| A' 扩展 `ev` 加 runId | 复用主会话的 `ev` 通道                                                                                                          | `ev` 是主会话的 seq 流：registry 的 `seq`、`prompts`（`registry.ts:376-383`）、history 的缓冲和 delivered 记录（`history.ts:323-336`）、`gap` 语义都按主会话设计；混进来会让每个看主会话的浏览器都收到子 agent 的 delta |
| C 混合（**选这个**）  | 打开时拉一次快照（分页靠拉），选中 run 期间 hub 引用计数订阅，agent 才挂 tap 推 `run_ev`，hub 只定向转发给订阅了该 run 的浏览器 | 实现量中等，但每一块都能复用现有部件                                                                                                                                                                                    |

### 2.2 选 C 的理由

- **多浏览器连接**：hub 维护 `(agentKey, runId) → Set<clientId>` 引用计数，计数 0→1 时发 `run_watch{on:true}`，1→0 时发 `{on:false}`。agent 侧每个 run 最多一个 tap，与浏览器数量无关。每个浏览器各自拿自己的快照（`run_tx_req`），`run_ev` 由 hub 扇出。
- **运行中和已终态分开处理**（见下表）。运行中的数据权威来源是内存 branch 加 tap，没有主会话那套 leaf/file/recent 对齐难题：agent 在**同一个同步 tick** 里执行 `tap.flush()`、读 `seq`、读 `getBranch()`、读 `tap.inflight()`，之后 `seq` 大于这个值的 `run_ev` 直接套用即可。即使 `message_end` 和快照重叠，也有 UI reducer 现成的 `messageKey` 去重兜底（`logic/state.js:572-591/666-684`）。
- **体积和限流**：快照默认取尾部 200 条，上限 2 MiB，分页每页最多 400 条/2 MiB；delta 沿用 `EventTap` 的 50ms 合并和 250ms 工具更新节流（`agent/event-tap.ts:1-16`、`messages.ts:429-430`）；每个 agent 最多 8 个 tap，每个浏览器 client 最多 2 个 run 订阅；`run_ev` 标记为可丢弃，一旦丢弃就转成 `run_gap`，浏览器重新拉快照。所有 `run_*` SSE 事件都**定向发送、不进 ring**，SSE 重连后由 UI 重新订阅。

| run 状态                                                  | 快照/分页                                                                                | live                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 运行中，handle 还在（`runner.ts:346` 的 `activeHandles`） | agent 内存 `getBranch()` 尾部投影（`source:"live"`）                                     | 有：`run_watch` 挂 tap，推 `run_ev`；run 结束时推 `run_end`                         |
| 运行中但 tap 已满（>8）                                   | 同上                                                                                     | 降级为 `live:false`，UI 显示 fleet 行的 `streamLine` 作为「进行中」预览，并提示原因 |
| 已终态，有文件                                            | agent 回 `source:"file"` 加 `sessionFile`，hub 读盘（leaf 取文件里最后一个带 id 的条目） | 无（`terminal:true`）                                                               |
| 已终态，`rememberAgents:false`                            | agent 回 `ok:false, code:"E_NOT_PERSISTED"`                                              | 无                                                                                  |
| 已从 registry 驱逐 / 未知 runId                           | `E_NOT_FOUND`                                                                            | 无                                                                                  |

### 2.3 为什么不走 cmd op，也不走 `/api/headless`

- cmd 是写路径：要经过幂等 ledger、16 个在途上限、审计、`ctl` 广播（`messages.ts:147-247`、`http.ts:1292+`）。读 transcript 混进去会污染 ctl 账本，还会挤占写操作的配额。
- `/api/headless*` 的存在理由是「没有目标 agent 也要能用」（`docs/dev/web-hub-spawn/arch.md`，`http.ts:2135`）。transcript 查询恰好**依赖**一个存活的 agent（registry 查找和进程内 handle），语义正好相反。

---

## 3. 协议设计

### 3.1 新文件 `src/web-hub/protocol/run-transcript.ts`

跟 `messages.ts` 一样是纯 TS 加 typebox，不 import `core/`（UI 也要用），自己定义正则，并用测试把它钉到 `core/ids.ts:10` 上。

```ts
export const RUN_ID_PATTERN = "^r_[0-9A-HJKMNP-TV-Z]{8}$";
export const RUN_TX = {
  tailDefault: 200, // 快照尾部条数
  pageMax: 400, // = HISTORY_PAGE_MAX
  maxBytes: LIMITS.branchReplyBytes, // 2 MiB / reply（单帧 4 MiB 内）
  tapsPerAgent: 8,
  subsPerClient: 2, // 切换 run 时的新旧重叠
  reqDeadlineMs: TIMING.snapshotMs,
} as const;

// hub→agent
export interface RunTxReqFrame {
  t: "run_tx_req";
  rid: string;
  runId: string;
  before?: string;
  limit: number;
  maxBytes: number;
}
export interface RunWatchFrame {
  t: "run_watch";
  runId: string;
  on: boolean;
} // 无应答、幂等

// agent→hub
export type RunTxReplyFrame =
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: true;
      source: "live" | "file";
      status: string;
      terminal: boolean;
      seq: number; // source:"live" 且 before 缺省时 = 该 run tap 当前 seq；未 watch 时为 0
      watching: boolean; // tap 是否在推（满额降级 ⇒ false）
      entries: WireEntry[]; // source:"file" 时恒为 []
      truncated: boolean;
      hasMore: boolean;
      inflight?: InflightState;
      sessionFile?: string;
    } // 仅 source:"file"；hub 消费后剥离，绝不转发给浏览器
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: false;
      code: "E_NOT_FOUND" | "E_NOT_PERSISTED" | "E_UNSUPPORTED";
      message?: string;
    };
export interface RunEvFrame {
  t: "run_ev";
  runId: string;
  seq: number;
  e: WireEvent;
} // e 同 ev 白名单（FORWARDED_EVENTS）
export interface RunGapFrame {
  t: "run_gap";
  runId: string;
  fromSeq: number;
}
export interface RunEndFrame {
  t: "run_end";
  runId: string;
  status: string;
  seq: number;
} // seq = 最后一个 run_ev 的 seq

// 浏览器面
export interface RunHistoryPayload {
  agentKey: string;
  runId: string;
  entries: WireEntry[];
  tailMessages: WireMessage[]; // tailMessages 恒为 []，形状与 HistoryPayload 同构，便于 reducer 复用
  inflight?: InflightState;
  fromSeq: number;
  hasMore: boolean;
  oldestEntryId?: string;
  source: "live" | "file";
  terminal: boolean;
  status: string;
  live: boolean;
}
export const RUN_SSE_EVENTS = ["run_history", "run_ev", "run_gap", "run_end"] as const;
export const RUN_API = {
  subscribe: "/api/run/subscribe",
  unsubscribe: "/api/run/unsubscribe",
  history: "/api/run/history",
} as const;
```

每个帧的 schema 都用 `additionalProperties:false`。但 `entries` 里的 `WireEntry` 和 `e` 沿用现有的宽松信任姿态（只校验 `type`/`role` 加总大小，见 `messages.ts:1-8`）。

### 3.2 接入现有文件（只做追加）

- `protocol/messages.ts`：`AgentFrame`/`HubFrame` 联合类型追加新帧类型（`:322-345`、`:385-397`）；`agentFrameSchemas`/`hubFrameSchemas` 两张表各加几项（`:998-1031`）。schema 本体从 `run-transcript.ts` import，减少和 spawn/upload 方案在 `messages.ts` 上的冲突面。
- `protocol/version.ts`：`PROTO` 改为 `{1, 2}`（`:10`，`protoCompatible` 只比 major，见 `:45-47`，新旧双向都能握手）；新增 `RUNTX_AGENT_CAPS = ["runtx.v1", "runtx.lan.v1"] as const`。
- `protocol/http-contract.ts`：`SSE_EVENTS` 追加 4 个事件名（`:18-40`）；`AgentCard` 追加 `runTranscript?: boolean; runTranscriptLan?: boolean`（`:78-96`）；re-export `RunHistoryPayload`。**不新增 `API_ERRORS`**，复用 `E_NOT_FOUND`/`E_UNSUPPORTED`/`E_BUSY`/`E_DEADLINE`/`E_AGENT_GONE`；`E_NOT_PERSISTED` 只出现在 agent↔hub 帧里，hub 把它映射成浏览器侧的 `404 E_NOT_FOUND`，并带 `message:"not-persisted"`。这样避开 upload 方案正在追加的 `API_ERRORS`。
- UI 镜像 `ui/src/logic/contract.js`：`SSE_EVENTS`/`API` 同步，由 `tests/web-hub/ui/logic-contract.test.ts` 防止漂移。

### 3.3 兼容矩阵

| 组合                                 | 行为                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 新 hub + 旧 agent（没有 `runtx.v1`） | `AgentCard.runTranscript` 缺省，UI 只显示抽屉里的 fleet 树，不显示 transcript 入口；hub 也不会给它发 `run_*`（按能力门控）                                                           |
| 旧 hub + 新 agent                    | 旧 hub 从不发 `run_watch`/`run_tx_req`；agent 只在收到 watch 之后才发 `run_ev`，零噪音；万一真发了，旧 hub 的 `decodeAgentFrame` 返回 undefined，直接忽略（`messages.ts:1038-1059`） |
| 新 hub + 新 UI + 旧 UI 构建          | UI manifest 的 `proto.major` 没变，`ui-root.ts:322` 不会拒绝；旧 UI 不认识的 SSE 事件会被 reducer 的 switch 默认分支忽略                                                             |
| LAN listener                         | 仅当 `card.runTranscriptLan` 为真才开放，hub 的 LAN 路由会再校验一遍（复用 upload 方案的 `upload.lan.v1` 门控先例）                                                                  |

### 3.4 浏览器 HTTP/SSE 面

```
POST /api/run/subscribe   {clientId, agentKey, runId}  → 202 {ok:true}
     400 E_BAD_REQUEST（runId 不匹配 RUN_ID_PATTERN）· 404 E_NOT_FOUND（clientId/agentKey）
     409 E_UNSUPPORTED（无 cap / LAN 未开）· 503 E_BUSY（该 client 已有 2 个 run 订阅）
     → 随后定向 SSE  run_history  RunHistoryPayload | {agentKey, runId, error, message?}
     → 之后 run_ev{agentKey,runId,seq,e} / run_gap{agentKey,runId,fromSeq} / run_end{agentKey,runId,status}
POST /api/run/unsubscribe {clientId, agentKey, runId}  → 200 {ok:true}（幂等）
GET  /api/run/history?agent=&run=&before=<entryId>&limit=<≤400>  → 200 RunHistoryPayload（裸 JSON，不包 SSE）
```

- 两个 POST 走现有的 CSRF/64 KiB/deadline 管线（`http.ts:9-12`）；GET 和 `/api/history` 一样要求会话（`http.ts:1258-1263`）。
- 订阅顺序完全照搬 `subscribe`/`runSnapshot`（`http.ts:733-786`）：先回 202，在 `pending` 期间缓冲该 `(client, run)` 的 `run_ev`，快照落定后先发 `run_history`，再发缓冲帧（丢弃 `seq < fromSeq` 的），缓冲溢出则补一个 `run_gap`，最后才加入 live 集合。
- **定向发送**：用 `client.send()` 逐个发给订阅者，不调用 `sse.publish`，因此不进 ring、不消耗事件 id。SSE 断开时（`res.once("close")`）清理该 client 的所有 run 订阅，并减引用计数。

---

## 4. agent 侧实现

### 4.1 runtime 读端口链（新增 R 包，全部是可选方法，只做追加）

| 层           | 文件                                                                                               | 新增                                                                                                                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| driver       | `src/runtime/session-driver.ts`（`SessionHandle` 在 `:60-110` 左右，`PiSessionHandle` 在 `:400+`） | `getBranchEntries?(): readonly unknown[]` → `this.session.sessionManager.getBranch()`（同类用法见 `:491/:519`）；`observe?(l: (e: unknown) => void): () => void` → `this.session.subscribe(wrapped)`。pi 会返回 unsubscribe 函数（`agent-session.js:801-810`），`wrapped` 内部用 try/catch 吞掉异常                        |
| runner       | `src/runtime/runner.ts`                                                                            | `peekRunBranch(runId)`、`observeRun(runId, {onEvent, onEnd})`，仿照 `steerRun`（`:431-435`）通过 `activeHandles` 取 handle。新增私有的 `runObservers: Map<runId, Set<…>>`；在清理块 `:893-894`（`activeHandles.delete` 旁边）对每个 observer 调一次 `onEnd()` 再 `unsub()`，全部吞异常（同 `notifyReaped` 的约定，`:899`） |
| service 端口 | `src/service/ports.ts`（`Runner`，`steer?` 在 `:56`）                                              | `peekBranch?(runId)`、`observe?(runId, l)`                                                                                                                                                                                                                                                                                 |
| adapter      | `src/service/runtime-adapter.ts:1042-1047`                                                         | 透传                                                                                                                                                                                                                                                                                                                       |
| query        | `src/service/query-service.ts`（`steer` 在 `:128-137`）                                            | `branchOf?(id)`、`observe?(id, l)`；仅当 `status === "running"` 且 runner 支持时返回值，否则返回 `undefined`                                                                                                                                                                                                               |

不变量：observer 永远不能把异常抛进 pi 的 listener，也不能延长 session 的生命周期；不引入 ref'd 定时器；不在模块作用域放状态。I1（core/service 不见 pi 类型）保持成立，所以端口签名里一律用 `unknown`。

### 4.2 `src/web-hub/agent/run-transcript.ts`（新）

```ts
export interface RunTranscriptPort {
  info(runId: string): { status: string; terminal: boolean; sessionFile?: string } | undefined; // ← QueryService.get(runId)
  branch(runId: string): readonly unknown[] | undefined; // ← branchOf
  observe(runId: string, l: { onEvent(e: unknown): void; onEnd(): void }): (() => void) | undefined;
}
export function createRunTranscripts(deps: {
  port: () => RunTranscriptPort | undefined;
  send: (f: AgentFrame, o?: { droppable?: boolean }) => boolean;
  now: () => number;
  setTimer: (ms: number, fn: () => void) => { cancel(): void };
  maxTaps?: number; // 8
}): {
  onReq(f: RunTxReqFrame): void; // 同步构造并发送 run_tx_reply
  onWatch(runId: string, on: boolean): void;
  onLink(live: boolean): void; // 断链 ⇒ 所有 tap 标记 gapped；恢复 ⇒ 逐个补 run_gap
  tick(): void; // 由 1Hz fleet tick 驱动：在背压缓解后补发 run_gap
  dispose(): void;
};
```

- **快照**（不带 `before`）：先 `tap?.flush()`，读 `seq`，再 `branch(runId)`，**从尾部往前**逐条 `projectSessionEntry`（`protocol/keys.ts:90`），直到达到 `limit` 或 `maxBytes`（字节计法同 `snapshot.ts:51-59`）。这样避免对整个长会话做投影。最后带上 `inflight = tap?.inflight()`。
- **分页**（带 `before`）：在 branch 里找到 `before` 的下标，往前切片，同样按字节截断；找不到返回 `E_NOT_FOUND`。
- **handle 不在了**：`info().terminal` 为真或 `branch` 返回 undefined 时，有 `sessionFile` 就回 `source:"file"`；没有文件（in-memory 会话）回 `E_NOT_PERSISTED`；`info` 都查不到则回 `E_NOT_FOUND`。
- **tap**：每个 run 一个 `createEventTap(sink, …)`（`event-tap.ts:56+`），直接复用主会话的 delta 合并、工具节流、64 KiB 截断和 inflight。sink 把事件包成 `run_ev{runId, seq: ++runSeq, e}`，以 `droppable` 方式 `send`，返回 false 就把这个 tap 标为 `gapped`。gapped 期间停止发送；等 `tick()` 时发现 send 恢复，就发一次不可丢弃的 `run_gap{runId, fromSeq}`。`onEnd` 时先 `tap.flush()`，再发 `run_end`，然后 dispose。超过 `maxTaps` 时不挂 tap，回复里 `watching:false`。
- `run_watch{on:false}` 或 dispose 时，调用 unsubscribe 并 `tap.dispose()`。

### 4.3 接线

- `src/web-hub/agent/connection.ts`：`BindingPort`（`:93-99`）追加可选的 `onRunTxReq?(f)`、`onRunWatch?(runId, on)`；hub 帧 switch（`:584-589` 附近）追加两个 case，同样要求 `link === "live"`；`send()`（`:313-329`）**返回值从 `void` 改成 `boolean`**（true 表示已写入）。改返回类型对现有调用方兼容，现有调用方都不读返回值。
- `src/web-hub/agent/index.ts`：在 `binding` 对象（`:400-455`）里接上 `onRunTxReq`/`onRunWatch`，`onStateChange` 时调用 `runTx.onLink(v.state === "live")`；在 fleet tick（`:327-331`）末尾调用 `runTx.tick()`；在 `capsExtra()`（`:506-514`）里按 `settings.subagentTranscript` 追加 caps（`"all"` 发 `runtx.v1`+`runtx.lan.v1`，`"loopback"` 只发 `runtx.v1`，`"off"` 不发）。它**不受 `control` 开关影响**，因为这是读面。`WebHubDeps.query`（`:103-107`）的 `QueryControlPort` 追加可选的 `branchOf?`/`observe?`，`QueryService` 在结构上天然满足。session 替换或 dispose 时调用 `runTx.dispose()`。
- `src/config/settings.ts`：`WebHubSettings` 追加 `subagentTranscript: "all" | "loopback" | "off"`，默认 `"all"`，非法值回退到默认。
- `src/index.ts:859-865`：不需要改。`query: () => holder.current?.query` 已经把 `QueryService` 传进去了。

---

## 5. hub 侧实现

### 5.1 `src/web-hub/hub/run-transcript.ts`（新，核心层，不碰 http）

```ts
export interface RunTranscriptService {
  snapshot(agentKey: string, runId: string): Promise<RunHistoryPayload>;
  page(agentKey: string, runId: string, before: string, limit: number): Promise<RunHistoryPayload>;
  watch(agentKey: string, runId: string): void; // 引用计数 +1，0→1 发 run_watch{on:true}
  unwatch(agentKey: string, runId: string): void; // -1，1→0 发 {on:false}
  dispose(): void;
}
```

- `snapshot`：要求 agent 声明了 `runtx.v1`（`registry.caps(agentKey)`，`registry.ts:263`），否则抛 `E_UNSUPPORTED`。调用方必须先 `watch`，保证 `run_watch` 在 `run_tx_req` 之前经同一条 socket 有序送达，从而快照时 tap 已经存在。然后 `registry.request<RunTxReplyFrame>(…, RUN_TX.reqDeadlineMs)`：`source:"live"` 直接组装 payload；`source:"file"` 就调用 `history.ts` 新导出的读盘函数；`ok:false` 映射成 `HubError`。整个过程包在与 `history.ts:401-420` 同款的 deadline 里，payload 用 `buildCappedHistoryPayload` 同款逻辑截断（实际线上单元是 SSE 帧）。
- `page`：同样先发 `run_tx_req{before}`，`source:"file"` 时读盘并在 branch 里按 `before` 切片（同 `history.ts:558-590`）。
- 订阅生命周期：订阅 bus 事件。`agent_down` 时清空该 agent 的所有计数（同 `history.ts:343-348`）。registry 在 reclaim 时若 epoch 变化会发 `gap{fromSeq:0}`（`registry.ts:286-303`），收到后对所有被订阅的 run 重新发 `run_watch{on:true}`，并发布 `run_gap` 让浏览器重新拉快照。

### 5.2 `src/web-hub/hub/history.ts`（小改）

- `parseIndex`（`:115-135`）的 `FileIndex` 追加 `lastId?: string`，记录文件顺序中最后一个带 id 的条目，即 `SessionManager.open` 视角下的 leaf。
- 导出 `readRunBranchFromFile(file, cache?)`：`readBranchCached` 的变体，leaf 取 `lastId`，复用同一个 `createFileCache`（服务里另开一个实例，4 项 LRU 不和主会话抢）。另外导出 `capEntriesByBytes`/`buildCappedHistoryPayload`，后者目前是模块私有的。

### 5.3 `registry.ts` / `ports.ts` / `hub.ts`

- `registry.ts`：`onFrame` 追加 `run_tx_reply`，按 rid 结算 pending（与 `:401-416` 同款）；`run_ev`/`run_gap`/`run_end` 发布成 bus 事件；`card()`（`:175` 附近）追加 `runTranscript: caps.includes("runtx.v1")`、`runTranscriptLan: caps.includes("runtx.lan.v1")`。
- `ports.ts`：`HubEvent`（`:382-410`）追加 `{type:"run_ev";agentKey;runId;seq;e}`、`run_gap`、`run_end`；追加 `RunTranscriptService` 接口；`FrontendDeps` 追加可选的 `runTx?`（先例见 upload 方案的 `uploads?`、`commands?`，`:482` 附近）。
- `hub.ts`：组装 `createRunTranscriptService({registry, log})`，传给 frontend，关闭时 dispose。

### 5.4 `src/web-hub/hub/run-routes.ts`（新）加 `http.ts` 接线

- `createRunRoutes(sse, {registry, runTx, log, isClosed})` 返回 `{onHubEvent, subscribe, unsubscribe, historyPage, onClientClose}`，自己维护 `pending` 和 `subs: Map<runKey, Set<clientId>>` 以及 `perClient: Map<clientId, Set<runKey>>`。把逻辑放在新文件里，http.ts 只改几行（http.ts 同时被 upload 和 spawn 方案修改）。
- `http.ts`：`createRouteSet`（`:614`）内部组装 run 路由，`onHubEvent` 把 `run_*` 转给它，`openEvents` 的 close 回调（`:770`）里调用 `onClientClose`。loopback 的 `handleApi` 在 `:2133-2141` 追加 POST/GET 三条路由；LAN 的 `handleLanRequestInner` 在 `:1226-1227` 和 `:1258` 附近追加同样三条，外加 `card.runTranscriptLan` 校验。

---

## 6. UI 布局与状态

### 6.1 结构（改 `AgentDetail.vue:515-564`）

```
<main class="detail" :data-drawer="drawerMode" :data-drawer-open="open">
  <DetailHeader/>
  <div class="detail-split">
    <div class="detail-main">           ← 原有：notices / ask_user / folded / skeleton|DetailBody / DetailDock
      DetailBody：FleetSummaryBar（替代 FleetPanel）+ Transcript
    </div>
    <FleetDrawer v-if="hasFleet || selectedRunId" id="fleet-drawer"/>   ← 新，处于 CONTROL_CTX 作用域内
  </div>
</main>
```

抽屉必须放在 `AgentDetail` 里面：`FleetActions` 依赖 `AgentDetail` 提供的 `CONTROL_CTX`（`:281-289`），放到 `DashboardView` 层就拿不到。composer（`DetailDock`）留在 `.detail-main` 里，停靠模式下宽度只覆盖主 transcript 那一栏。

### 6.2 三种模式（CSS 负责视觉，JS 只负责行为）

| 模式       | 媒体查询              | 视觉                                                                                                                                           | 行为                                                                                                                        |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| docked     | `(min-width: 1280px)` | `.detail-split{grid-template-columns:minmax(0,1fr) var(--drawer-w)}`，`--drawer-w: clamp(360px, 30vw, 520px)`；关闭时退回单栏                  | 开合状态持久化到 localStorage（`webhub.fleetDrawer.open`，默认 `"1"`）；不做焦点陷阱；点外部不关闭                          |
| overlay    | `768–1279px`          | `position:absolute; inset-block:0; right:0; width:min(420px, 85%); z-index:30; box-shadow:var(--shadow-3)`，覆盖在主 transcript 上，主栏不重排 | 每次挂载默认关闭，不持久化；Esc 或点外部关闭；`role="dialog"`，焦点移到关闭按钮，关闭后还给 `FleetSummaryBar` 的按钮        |
| fullscreen | `(max-width: 767px)`  | `position:fixed; inset:0; z-index:40`（低于 `base.css:141` 跳转链接的 50）                                                                     | 同 overlay；树和 transcript **二选一显示**（选中 run 后显示 transcript，顶部「← 子 agent 列表」返回树）；Esc 先关抽屉，见下 |

- 模式判定：在 `FleetDrawer`/`AgentDetail` 里用 `useMedia(window, "(min-width:1280px)")` 和 `"(max-width:767px)"`，复用 `composables/useMedia.ts`。
- **Esc 冲突**：`DashboardView.vue:83-91` 窄屏下按 Esc 会返回列表。抽屉打开时它自己的 keydown 处理器会 `stopPropagation()`，并在 `DashboardView` 的处理器之前生效（抽屉在 `document` 上注册 capture 阶段监听，或者在 `DashboardView` 里加一个 `ev.defaultPrevented` 判断，二选一，实现时选侵入更小的那个）。
- 抽屉内部（docked/overlay）是纵向两段：上面是 fleet 树（`flex:0 1 auto; max-height:40%`，选中 run 后自动收缩为只占 `max-height:30%`），下面是 run 头（名称、类型、模型、状态、耗时、费用，取自选中 run 的 `FleetRowWire`，以及运行中时的 `FleetActions` steer/stop）加 `RunTranscript`（`flex:1`）。没选中时下段显示「选择一个子 agent 查看对话」空态。
- 高亮：选中行 `aria-current="true"` 加 `data-selected`，样式加在 `fleet.css`。

### 6.3 FleetPanel 的迁移

| 现状                                                                                                             | 去向                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FleetPanel.vue` 的 `<summary>` 摘要行（标题、运行中数量、总数和费用）                                           | 改成 `fleet/FleetSummaryBar.vue`：一行、常驻文档流，本身是 `<button aria-controls="fleet-drawer" :aria-expanded>`，用来开合抽屉；docked 打开时用 CSS 隐藏（`[data-drawer="docked"][data-drawer-open] .fleet-summary{display:none}`）。统计逻辑抽到 `fleet/summary.ts`（纯函数），FleetSummaryBar 和抽屉头共用                                                  |
| `FleetPanel.vue` 的树列表（`rootFold` 加 `FleetNode` 循环加「Show N Finished」）                                 | 改成 `fleet/FleetTree.vue`，抽屉里使用                                                                                                                                                                                                                                                                                                                         |
| 浮层机制（`<details>` 开合、文档级 pointerdown/Esc、`fleet.css:72-91` 的 `.tree-scroll` absolute/z-index/34dvh） | **删除**。`.tree-scroll` 改成静态的可滚动容器；Esc 和点外部的逻辑迁到 `FleetDrawer`，只在 overlay/fullscreen 下生效                                                                                                                                                                                                                                            |
| `FleetNode.vue`                                                                                                  | 保留。新增「打开 transcript」入口：`run-name` 区域包成 `<button class="run-open">`，`@click.stop.prevent` 后调用注入的 `FLEET_SELECT.select(runId)`。这样父节点的 `<summary>` 原生折叠（点 chev 或行其余部分）不受影响；叶子行整行可点。只有 `card.runTranscript`（LAN 下看 `runTranscriptLan`）为真时才渲染成按钮，否则保持纯文本。`⋯` 和 `FleetActions` 不动 |
| `FleetActions.vue`                                                                                               | 不改。抽屉的 run 头里给选中的运行中 run 再挂一份（同一个组件，`:run-id` 为选中 id）                                                                                                                                                                                                                                                                            |
| `contracts.ts` 的 `FleetPanelProps`（`:236-240`）                                                                | 换成 `FleetTreeProps{rows, now}` 和 `FleetSummaryBarProps{rows, open, controls}`；同时新增 `FleetDrawerProps`、`RunTranscriptProps`。这是对 P0 冻结面的一次**有意修订**，在 PR 里写明                                                                                                                                                                          |

### 6.4 Transcript 复用

- `TranscriptProps.agent` 的类型从 `AgentState` 收窄为 `TranscriptSource = Pick<AgentState, "key"|"items"|"streaming"|"tools"|"history"|"historyError"|"hasMore"|"paging">`；`buildTxEntries`（`entries.ts:176`）和 `indexTools`（`tool-index.ts:27`）的参数同步收窄。`AgentState` 天然满足这个类型，主会话调用方零改动。
- `Transcript.vue:155` 写死了 `id="transcript"`（深链滚动目标），同时挂两个实例会撞 id。新增可选 prop `anchorId`，默认 `"transcript"`，抽屉传 `"run-transcript"`。
- `TxUser.vue:25` 的 web 徽标是从 `CONTROL_VIEW` 注入的主会话 ctl 账本推出来的，放到子 run 上会误判。`RunTranscript.vue` 里 `provide(CONTROL_VIEW, null)` 把它覆盖掉。
- `RunTranscript.vue` 自己持有 `following`/`newCount`，并带一个迷你「↓ 最新」按钮（复用 `TxHiddenGap` 和 `jumpToLatest` 的约定），不复用 `DetailDock`。`live:false` 时在底部渲染 fleet 行的 `streamLine` 作为「进行中」预览，并显示降级原因。

### 6.5 状态管理（`logic/state.js` 加 `useHub.ts`）

- `AgentState` 追加 `runSel: string | null`（每个 agent 记住一个选中 run，切换 agent 再回来时保留）和 `runTx: RunTxState | null`。`RunTxState` 和 transcript 相关的那部分子集同形：`{runId, items, keys, entryIds, uid, lastSeq, streaming, tools, history, historyError?, hasMore, oldestEntryId?, paging, needsResync, terminal, status, live, source, pending}`。
- 复用 reducer 里现成的纯函数：从 `applyHistory`（`:593-637`）、`applyPage`（`:639-653`）、`applyEv`/`applyEvent`（`:686-833`）抽出操作 `{items, keys, entryIds, uid, streaming, tools, ...}` 子集的内核，主会话和 run 共用（行为不变，由 `logic-state.test.ts` 兜住）。新增 case：`run_select`、`run_subscribing`、`run_history`、`run_ev`（`seq <= lastSeq` 丢弃）、`run_gap`（置 `needsResync`）、`run_end`（`terminal=true; live=false`）、`run_paging`/`run_page`/`run_page_failed`、`run_unsubscribed`；`run_*` 的 `runId` 和 `a.runTx.runId` 对不上的一律丢弃。
- `useHub.ts`：新增 `selectRun(agentKey, runId|null)` 和 `pageRun(agentKey)`。选中时 `transport.runUnsubscribe(旧)` 再 `runSubscribe(新)`；当前 agent 切走时（`:115-122` 的退订路径）连带退订它的 run，切回来时如果 `runSel` 有值就重新订阅；收到 `hello`（SSE 重连换了 clientId）、遇到 `needsResync` 时按 `resyncMinIntervalMs` 限速重订（`:125-140` 同款）。
- `types.ts`：镜像 `RunTxState`，并给 `HubHandle` 加上 `selectRun`/`pageRun`。
- transport：`HubTransport`（`transport/types.ts:66-75`）追加**可选**的 `runSubscribe?`/`runUnsubscribe?`/`runPage?`（同 upload 方案 `upload?` 的追加先例）；`logic/token-client.js`、`logic/password-client.js` 实现它们（复用 `postRaw`/`withRelogin`/`postApi`）；`transport/{token,password}.ts` 适配。

---

## 7. 安全与权限

- **属于读面，敏感性和主会话 transcript 同级**：两者都是同一用户、同一 pi 进程产生的消息、工具调用和结果。子 agent 常做大面积 `read`（代码、配置），单份内容可能更多，但信息类别没有增加。主会话 transcript 已经通过 `/api/history` 和 SSE 下发，子 agent 不额外设门槛，鉴权与 `/api/history` 一致（loopback 用 token cookie，LAN 用 `requireLanSession`）。
- **路径从不来自浏览器**：浏览器只给 `agentKey` 和 `runId`。runId 先用 `RUN_ID_PATTERN` 校验，再由 agent 在自己的 registry 里解析。`sessionFile` 只在 agent→hub 帧里出现，hub 读盘前做 realpath、`.jsonl` 后缀和普通文件校验（`history.ts:84-98`），读完从 payload 里剥掉，**绝不下发给浏览器**。
- **LAN 明文**：沿用现有 `plainHttp` 提示姿态（`ControlNotice` 的 plainHttp 变体）。另外提供 `webHub.subagentTranscript: "loopback"` 这一档，在不想通过 LAN 明文暴露更多 `read` 结果的场景下只在本机开放；hub 在 LAN 路由上再校验一次 `runtx.lan.v1`，两层把关。`"off"` 是全局开关。
- **资源防护**：每个 client 最多 2 个 run 订阅（超出返回 `E_BUSY`）；每个 agent 最多 8 个 tap（超出降级为非 live）；单次回复不超过 2 MiB；请求有 deadline（同 `HISTORY_GUARD_MS`）；LAN 侧另有 conn-guard 和在途配额（`requireLanSession` 的 lease）。读操作不进审计，与 `/api/history` 一致。
- **child session 隔离**：web-hub 在 post-guard 位置接线（AGENTS.md），子会话里不激活；tap 只挂在父进程对子 session 的 `subscribe` 上，不改子会话的任何行为，也不改写 payload。

---

## 8. 拆包、依赖与验收

### 8.1 包表

| 包                    | 文件域（排他）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依赖                                                                         | 验收（全部要求 `npm run typecheck` 通过，且列出的 vitest 用例绿）                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 协议冻结**       | `protocol/run-transcript.ts`（新）；`protocol/messages.ts`（联合类型和 schema 表的追加项）；`protocol/version.ts`（PROTO 1.2，`RUNTX_AGENT_CAPS`）；`protocol/http-contract.ts`（SSE_EVENTS、AgentCard 字段、re-export）；`ui/src/logic/contract.js`（镜像）；测试 `tests/web-hub/protocol/run-transcript.test.ts`（新）、`version.test.ts`、`messages.test.ts`、`tests/web-hub/contract/types.test-d.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 无                                                                           | 每个新帧正反例都能 decode，未知字段被拒；超过 4 MiB 的帧被拒；`RUN_ID_PATTERN` 与 `core/ids.ts` 的 `isRunId` 在 1k 个随机样本上结论一致；旧帧解码零回归；`logic-contract.test.ts` 绿                                                                                                                                                                                 |
| **R1 runtime 读端口** | `runtime/session-driver.ts`、`runtime/runner.ts`、`service/ports.ts`、`service/runtime-adapter.ts`、`service/query-service.ts`；测试 `tests/runtime/runner-observe.test.ts`（新）、`tests/runtime/session-driver.test.ts`（追加）、`tests/service/query-service-transcript.test.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 无（与 P0 并行）                                                             | observer 收到原始事件；run 到达终态时 `onEnd` 恰好调用一次并完成 unsubscribe；listener 抛异常不影响 run 结局和其他 observer；未运行的 run 返回 `undefined`；`PiSessionHandle.observe` 用假 session 验证 unsubscribe 生效；`tests/runtime`、`tests/service` 全绿，状态机矩阵不动                                                                                      |
| **A1 agent 侧**       | `web-hub/agent/run-transcript.ts`（新）；`agent/connection.ts`（BindingPort、hub 帧 case、`send` 返回 boolean）；`agent/index.ts`（binding、tick、capsExtra、deps 类型）；`config/settings.ts`（`subagentTranscript`）；测试 `tests/web-hub/agent/run-transcript.test.ts`（新）、`connection.test.ts`、`wiring-control.test.ts`、`tests/config/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | P0；R1 只依赖接口（测试用假 port）                                           | 快照在同一 tick 内对齐（构造「快照后到达的 message_end」用例，UI 侧去重后不重复）；尾部投影按 limit 和字节截断，`hasMore`/`truncated` 正确；`before` 分页正确；终态/in-memory/未知三种分支的回复码正确；tap 上限降级为 `watching:false`；背压时 droppable 发送失败转 `run_gap`；断链后恢复补 gap；`run_end` 先于 dispose 且 seq 正确；三档设置对应的 hello caps 正确 |
| **H1 hub 服务**       | `hub/run-transcript.ts`（新）；`hub/history.ts`（`lastId`、导出读盘与截断函数）；`hub/registry.ts`（frame case、card 字段）；`hub/ports.ts`（HubEvent、接口、FrontendDeps）；`hub/hub.ts`（组装）；测试 `tests/web-hub/hub/run-transcript.test.ts`（新）、`history.test.ts`、`registry.test.ts`、`hub.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P0                                                                           | 引用计数 0→1/1→0 只各发一次 watch；watch 先于 req 发出；file 源读盘取最后条目作 leaf；字节截断后的 SSE 帧不超过 2 MiB；`sessionFile` 不出现在 payload 中；`agent_down` 清空计数；epoch 变化后重发 watch 并发布 run_gap；没有 cap 时返回 `E_UNSUPPORTED`；主会话 `history.test.ts` 零回归                                                                             |
| **H2 hub HTTP**       | `hub/run-routes.ts`（新）；`hub/http.ts`（routeSet 组装、loopback 和 LAN 路由、close 钩子）；测试 `tests/web-hub/http/api-run.test.ts`（新）、`lan-run.test.ts`（新）、`sse.test.ts`、`security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | H1                                                                           | subscribe 返回 202，随后先 `run_history` 再缓冲帧（丢弃 `seq<fromSeq`）、溢出补 gap；run 事件不进 ring（`Last-Event-ID` 重放里没有 `run_*`）；第 3 个订阅返回 503；runId 非法返回 400；LAN 下缺少 `runtx.lan.v1` 返回 409；未登录返回 401；POST 缺 CSRF 返回 403；SSE 关闭后计数归零                                                                                 |
| **U1 UI 逻辑和传输**  | `ui/src/logic/state.js`；`logic/token-client.js`、`logic/password-client.js`；`ui/src/transport/{types,token,password}.ts`；`ui/src/composables/useHub.ts`；`ui/src/types.ts`；测试 `tests/web-hub/ui/logic-state.test.ts`、`logic-run-tx.test.ts`（新）、`transport-contract.test.ts`、`use-hub.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P0                                                                           | 主会话 reducer 零回归；`run_history`/`run_ev`/`run_end`/`run_gap`/分页的状态转换正确；runId 错配时丢弃；`seq<=lastSeq` 丢弃；两个 transport 的 run 方法对称（同一套假 fetch）；selectRun 切换时先退订再订阅；切 agent 时连带退订；hello 后重订有限速                                                                                                                 |
| **U2 抽屉和布局**     | `ui/src/components/drawer/{FleetDrawer,RunTranscript,RunHeader}.vue`（新）；`components/fleet/{FleetTree,FleetSummaryBar}.vue`（新）、`fleet/summary.ts`（新）、删除 `FleetPanel.vue`、`FleetNode.vue`；`components/body/DetailBody.vue`；`components/detail/AgentDetail.vue`；`components/transcript/{Transcript.vue,entries.ts,tool-index.ts}`（类型收窄、`anchorId`）；`components/shell/DashboardView.vue`（只改 Esc 让位）；`contracts.ts`；`styles/drawer.css`（新）、`styles/fleet.css`、`styles/detail.css`；`i18n/{en,zh}/drawer.ts`（新）加 `i18n/index.ts`；测试 `tests/web-hub/ui/fleet-drawer.test.ts`（新）、`run-transcript.test.ts`（新）、`fleet.test.ts`、`detail-body.test.ts`、`transcript.test.ts`、`dashboard-view.test.ts`、`source-scan.test.ts`（白名单加 `drawer/FleetDrawer\.vue`，canary 列表加新文件）、`i18n-parity.test.ts` | U1 只依赖接口（可先用桩）；布局部分（抽屉加树，不含 transcript）可与 U1 并行 | 见 §9.3；外加 `npm run build:web` 通过，产物 manifest 校验通过（`ui-manifest.test.ts`）                                                                                                                                                                                                                                                                              |
| **V 验收**            | `docs/dev/web-hub-fleet-drawer/acceptance.md`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 全部                                                                         | tmux 真机验收：3 个并发子 agent、两个浏览器同时看同一个 run 和不同 run、长会话（≥40 MB）终态 run 的分页、`rememberAgents:false`、LAN 明文模式和 `"loopback"` 档位、hub 重启和 `/reload` 后自动恢复；CI 四件套（format:check、typecheck、test、build）加 `build:web` 全绿                                                                                             |

### 8.2 并行图

```
P0 ─┬─► A1 ─┐
    ├─► H1 ─► H2 ─┤
    └─► U1 ─► U2(transcript 部分) ─► V
R1 ──► (A1 联调)   U2(布局部分) 可与 U1 并行
```

关键路径是 P0 → H1 → H2 → V，以及 P0 → U1 → U2 → V。R1 与 P0 同时开工。

### 8.3 与在途方案的文件域冲突

| 共享文件                                                                  | upload（`docs/dev/web-hub-upload/plan.md` §6） | spawn（`docs/dev/web-hub-spawn/arch.md`） | 本方案                                                             | 处置                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `protocol/version.ts`                                                     | `UPLOAD_*_CAPS`                                | —                                         | PROTO 1.2、`RUNTX_AGENT_CAPS`                                      | 都是追加；PROTO minor 由**先合入的那个方案**来升，后合入的 rebase 时确认不重复升级 |
| `protocol/http-contract.ts`                                               | `API_ERRORS` 加 4 个码，AgentCard 加 `upload*` | —                                         | SSE_EVENTS 和 AgentCard 加 `runTranscript*`；**不碰 `API_ERRORS`** | 追加位置不同                                                                       |
| `protocol/messages.ts`                                                    | —                                              | `:20`、`:329-334`                         | 联合类型和 schema 表追加                                           | 冲突小；schema 本体放在独立文件                                                    |
| `hub/registry.ts` `card()`                                                | `:175` 加 upload                               | —                                         | 同一位置加 runTranscript                                           | 同一函数相邻行追加，手工 rebase                                                    |
| `hub/http.ts`                                                             | upload 路由、`FrontendDeps`                    | `:2135` 附近 headless                     | `createRouteSet` 加 3+3 条路由                                     | 逻辑放进 `run-routes.ts`，http.ts 只改十几行                                       |
| `hub/ports.ts`、`hub/hub.ts`                                              | `uploads?` 组装                                | —                                         | `runTx?` 组装                                                      | 追加                                                                               |
| `agent/index.ts`                                                          | `capsExtra` `:506-514`                         | `:486-505`、`:561-562`                    | `capsExtra`、binding、tick                                         | 三方都动同一函数，**按合入顺序串行**，各自的测试钉住 caps                          |
| `agent/connection.ts`                                                     | —                                              | `:143`、`:708`                            | BindingPort、`send` 返回值                                         | 区域不同                                                                           |
| `config/settings.ts`                                                      | `webHub.uploads`                               | —                                         | `webHub.subagentTranscript`                                        | 追加                                                                               |
| `ui/transport/*`、`logic/*-client.js`、`logic/contract.js`、`ui/types.ts` | `upload?`                                      | —                                         | `run*?`                                                            | 都是可选追加                                                                       |
| `tests/web-hub/ui/source-scan.test.ts`                                    | 断言无 localStorage（不改白名单）              | —                                         | 白名单加一项                                                       | 本方案独自修改白名单                                                               |
| `components/agents/AgentList.vue`                                         | —                                              | `:118-125`                                | 不碰                                                               | 无冲突                                                                             |

建议：三个方案的 P0/S0 协议包**串行合入**，每个都先 rebase 到最新 master 再开下游包；同一时刻只允许一个方案的包修改 `agent/index.ts` 和 `hub/registry.ts`。

---

## 9. 测试策略

### 9.1 协议契约

- `tests/web-hub/protocol/run-transcript.test.ts`：每个帧的最小合法、全字段、多余字段、类型错误、超大四类用例；`run_tx_reply` 的 ok/err 两个分支互斥（照 `LanRes` 的 strict 写法，`messages.ts:977-996`）。
- `types.test-d.ts`：TS 接口和 typebox schema 一致；`RunHistoryPayload` 能赋值给 reducer 复用内核所需的子集类型。
- `logic-contract.test.ts`：UI 镜像的 `SSE_EVENTS`/`API` 与协议同源。

### 9.2 agent 侧投影和 runtime

- `runner-observe.test.ts`：用假 driver 驱动 `session_created`→若干事件→终态，断言 observer 的完整生命周期，以及 reaper 清理路径（`:880-896`）下 `onEnd` 只调一次。
- `run-transcript.test.ts`（agent）：注入假 port（内存 branch 数组加可手动触发的 observe）、假 `send`（可以模拟返回 false）。用例覆盖对齐、尾部投影、分页、三种降级、tap 上限、背压转 gap、断链补 gap、`run_end` 顺序，以及 `dispose` 后再收到帧不产生任何发送。
- 性能护栏：一个 20k 条目的 branch 做尾部快照，只投影 ≤ limit 条（统计 `projectSessionEntry` 调用次数），单次耗时 < 50ms（宽松阈值，只防退化）。

### 9.3 UI 抽屉交互（happy-dom + `@vue/test-utils`）

- `fleet-drawer.test.ts`：三种模式下（mock `matchMedia`）的渲染和 `data-drawer`；docked 的开合写入 localStorage 并在重挂载后恢复，overlay/fullscreen 不写；Esc 和点外部只在 overlay/fullscreen 下关闭；fullscreen 下树和 transcript 互斥，返回按钮可用；Esc 不会冒泡到 `DashboardView`（不触发 back）；焦点进入和归还；fleet 为空且没有选中时不渲染抽屉。
- `fleet.test.ts`：`FleetTree` 替代 `FleetPanel` 后，折叠、深度 ≥3 默认折叠、「Show N Finished」逻辑原样通过；`run-open` 按钮只在 `card.runTranscript` 为真时出现；点击它不切换父 `<details>`；`⋯`/`FleetActions` 不受影响（`fleet-actions.test.ts` 零改动保持绿）。
- `run-transcript.test.ts`（UI）：`RunTranscript` 渲染 `runTx`；`live:false` 时显示 streamLine 预览；`terminal` 状态标记；`load-older` 调用 `pageRun`；`CONTROL_VIEW` 被覆盖为 null，web 徽标不出现；DOM 里没有重复的 `id="transcript"`。
- `detail-body.test.ts`/`transcript.test.ts`：`FleetSummaryBar` 取代浮层；`Transcript` 用 `Pick` 类型传入主会话 `AgentState` 时零回归。
- `source-scan.test.ts`：新组件不使用 `innerHTML`/`randomUUID`/`<Transition>`；localStorage 只出现在白名单内。
- `npm run build:web`，加上 `tests/web-hub/ui/ui-manifest.test.ts`。

### 9.4 端到端（hub 进程内）

- `tests/web-hub/http/api-run.test.ts`：用 `helpers.ts` 起 hub，接一个假 agent socket（回 `run_tx_reply`/推 `run_ev`），两个 SSE client：A、B 订阅同一个 run 时只发一次 watch；A 退订后仍不发 off；B 退订后发 off；终态 file 源走真实的临时 jsonl。
- `lan-run.test.ts`：LAN 会话加 cap 门控。

---

## 10. 不做 / 后续

- run 的深链（`#/agent/<key>/run/<runId>`）：要改 `useHashRoute.ts`，作为独立小包放到后续。
- 抽屉宽度拖拽、记忆宽度。
- 子 run 的 transcript 内搜索。
- 已从 agent registry 驱逐的历史 run（不在 fleet 里）：本方案返回 `E_NOT_FOUND`；以后要做可以接 consult 的 expert-index 记录（`consult/expert-index.ts:129+`）。
- `Agent({resume})` 复用同一个 sessionFile 时，transcript 会包含之前那次 run 的历史，这是预期行为，在 UI 文案里注明。

## 11. 待评审确认

1. `webHub.subagentTranscript` 默认值用 `"all"`（与主会话 transcript 同级），还是保守些用 `"loopback"`？
2. overlay 区间（768–1279px）是否接受「覆盖而不挤压」？另一种做法是在 1025–1279 区间也停靠，但要把 `--sidebar-w` 压到 260px。
3. 选中 run 的 live 订阅在**当前 agent 切走时立即退订**（本方案），还是保留 N 秒宽限，以减少来回切换时重新拉快照？
