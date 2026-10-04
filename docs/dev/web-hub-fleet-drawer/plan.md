# web-hub 右侧 fleet 抽屉 + subagent transcript 通道：实施方案 v2

> 状态：v2，针对评审 5 个 blocker、9 个 major、2 个 minor、1 个 nit 的修订稿，待复审。
> 范围：把 web 端 fleet 从「顶部浮层」改成「右侧抽屉」。抽屉里放 fleet 树和所选子 agent 的 transcript，子 agent 运行中尽量做到 live。
> 用户已拍板「抽屉和 transcript 通道绑在一起，一次做完」。
> 基线：`0d81592`（HEAD）。工作区里还有 upload 方案 U1 尚未提交的改动（`protocol/version.ts`、`http-contract.ts`、`registry.ts`、`hub/http.ts`、`agent/index.ts`、`config/settings.ts` 等）。
> 本文行号**全部以 HEAD 已提交内容为准**（用 `git show HEAD:<file> | grep -n` 核对过）；关键事实写成「稳定符号名 + 行号」，行号漂移时以符号为准。
> v1 的行号有一部分是从多文件 `cat -n` 的连续编号里抄的，已经全部重新核对（#15）。

## v2 修订记录

| #   | 级别    | 评审意见（摘要）                                                             | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 落点                              |
| --- | ------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | blocker | 终态 run 不能拿文件物理末行当 leaf（append-only tree，末行可能属于废弃分支） | 删除「末行当 leaf」。runner 在 `sealBeforeTerminal`（`runtime/runner.ts:488`，每个 (runId, gen) 只执行一次的终态前封存点）读取 `handle.getLeafId()`，派发元数据事件 `session_event{t:"final_leaf"}`，写入 `RunDiagnostics.finalLeafId`。agent 在 `run_tx_reply` 里带上这个 leafId，hub 读盘时**只按该 leafId 沿 parentId 回溯**（与 `walkBranch` 语义相同，`hub/history.ts:142`）。拿不到 leaf ⇒ 返回确定的错误 `leaf_unknown`，绝不猜。补 fork、branch、resume、compaction、child switch_context 五类验收 | §4.1、§5.2、§9 F1/F3a，矩阵 T1–T6 |
| 2   | blocker | `run_end` 断链或背压时丢失 ⇒ 浏览器永远 pending                              | 三层兜底：(a) agent 侧对未写出的 `run_end` 建有界重试表 `endedPending`（32 条，TTL 10 分钟），在 tick 和 link-up 时重发，且永远排在补发的 gap 之后；(b) hub 侧建有界 `RunEndLedger`（256 条，TTL 15 分钟），负责去重，并在重订阅时强制走终态快照；(c) `run_end` 携带 `lastSeq`，hub 和浏览器任一侧发现 `lastSeq` 对不上，一律重新快照，不直接置终态。浏览器另有订阅 watchdog（10 秒收不到 `run_history` ⇒ 重订阅，最多 2 次，之后进入可重试的错误态）                                                      | §3.4、§3.5、§5.3，矩阵 S1–S8      |
| 3   | blocker | 订阅代际与幂等规则不清                                                       | 照搬 `PendingSub` 的对象身份语义（`hub/http.ts:735-760`、`:746`）：每个 (client, run) 一个 `RunSub` 对象，带 `gen` 和 `phase:"pending"\|"live"`；pending 期间缓冲**所有** `run_ev`、`run_end` 和 resync 标记，history 成功后按顺序统一下发；旧代 reply 一律丢弃。重复 subscribe、unsubscribe、SSE close、agent_down、session 切换的幂等规则写成表冻结                                                                                                                                                      | §5.4，矩阵 G1–G9                  |
| 4   | blocker | LAN 门控：默认值 + 工程实现                                                  | **默认 `"all"` 由用户裁定，不再争论**，见 §7.0「威胁模型与已接受风险」。工程部分已吸收：`createRouteSet` 和 run 路由显式携带 `listener:"loopback"\|"lan"`，hub 在每次 subscribe/page 时按 listener 要求 `runtx.v1` 或 `runtx.lan.v1`（看 `registry.getCaps`，**不依赖 UI 或 card**）；agent 重新 hello 导致 caps 变化时，回收不再合格的订阅；验收按 agent cap × agent setting × listener 三层组合覆盖                                                                                                      | §5.4、§7，矩阵 L1–L10             |
| 5   | blocker | 和 upload/spawn 的串行约定要能执行                                           | 唯一合入顺序 **upload → spawn → fleet**。fleet 凡是碰热点文件的包，只能基于 spawn SP11 合入后的 master 开工，并且必须先贴出闸门命令的结果。热点文件逐个定 owner 和合并点。新增三方能力共存测试 `caps-coexist.test.ts`，钉住 `HubInfo.caps`（`hub/hub.ts:227`）与 `hello_ack.caps`（`hub/agent-server.ts:153`）集合相等，并覆盖 upload、spawn、runtx 三组 caps                                                                                                                                              | §8.3、§8.4                        |
| 6   | major   | `send():boolean` 语义不精确                                                  | 不改 `send()`，新增 `trySend(): "written"\|"dropped"\|"not_live"\|"failed"`，`writeRaw` 改为私有地返回结果。每种结果对应的处理写成表；run 事件的 seq **在发送前先占号**，凡是未写出，都记入 `firstMissing`，之后转成 gap                                                                                                                                                                                                                                                                                   | §4.3                              |
| 7   | major   | `observeRun` 的线性化点                                                      | 线性化点 = runner 中央 `dispatch`（`runner.ts:577-587`）里首次进入终态的那次 reduce。注册时 run 已终态或没有 handle，同步返回 `{kind:"terminal"}` 等结果；`onEnd` 由「终态 dispatch」「finally 清理（`:894`）」两路竞争，用 per-observer `done` 标志保证恰好一次；unsubscribe 不触发 `onEnd`。用真实 `RuntimeRunner` 测试                                                                                                                                                                                  | §4.1                              |
| 8   | major   | 46.9MB 文件解析阻塞 hub                                                      | 新增 `hub/run-file-reader.ts`：**从文件尾部反向分块扫描**，用 `"id":"<want>"` 子串预筛，只 `JSON.parse` 命中行；每 1 MiB 让出一次事件循环；同 key single-flight；全局最多 2 个并发扫描；游标 LRU 16 条；扫描字节上限 256 MiB。验收包括两个 tab 并发加载、LRU 淘汰、扫描期间 `/healthz` 的 p99                                                                                                                                                                                                              | §5.1，矩阵 P1–P5                  |
| 9   | major   | seq/gap 协议没冻结                                                           | 冻结如下：每个 tap 有随机 `tapId`，seq 从 1 开始，未发出的事件也占号；gap 上报 `firstMissing`；未上报的 gap 合并取最小值；快照 watermark = 应答时刻的 tap seq；hub 和浏览器都按 `lastSeq+1` 检查连续性；resync 进行中暂停连续性检查；`run_end.lastSeq` 必须对齐。乱序、重复 gap、gap 之后到 end、重连交错都有测试                                                                                                                                                                                          | §3.3                              |
| 10  | major   | 终态 UX（rememberAgents:false、首条 assistant 前失败等）                     | 冻结 reason 枚举 `unknown_run`/`not_persisted`/`file_missing`/`leaf_unknown`/`leaf_missing`/`too_large`/`parse_error`，以及各自的 HTTP 状态和文案。**不在内存里保留** final snapshot（理由见 §3.6）；已经在看的 live 视图在 run 结束后保留已收到的内容                                                                                                                                                                                                                                                     | §3.6、§6.6                        |
| 11  | major   | transport 认证恢复                                                           | `REST_AUTH_PATHS`（`transport/password.ts:36`）加入 run 的三个端点。token 模式：subscribe/page 走 `withRelogin`，unsubscribe 发出即不管；password 模式：401 ⇒ `onConn("auth")`。SSE close 时 hub 清掉全部 run 订阅，UI 在 `hello` 后重订当前选中的 run。`E_BUSY` 的自愈步骤也写清了                                                                                                                                                                                                                        | §6.5                              |
| 12  | major   | 降级渲染与超出 cap 时的可见性                                                | 把 `streamLine \|\| toolTrail`（`FleetNode.vue:37-42`）抽成 `fleetActivity()` 共用。`fleet` 帧新增可选的 `omitted:{active,terminal}`，树底部显示「另有 N 个未列出」；父 run 未列出时，子 run 作为根节点显示并标注「父 run 未列出」。被选中的 run 移出列表后，用 `lastRow` 继续显示。补三级嵌套、64 个以上 active、8 个以上 terminal 的验收                                                                                                                                                                 | §3.2、§6.3                        |
| 13  | major   | Esc 与浮层互斥的实现契约                                                     | 唯一的 listener owner 是 `FleetDrawer`：只在 overlay/fullscreen 打开时，在 `document` 的 **bubble** 阶段监听；元素级处理器（`FleetActions.vue:74-77` 的 stop 解除武装）先执行并且可以拦截；抽屉处理后 `preventDefault()` + `stopPropagation()`，`DashboardView`（`window` 上的监听，`:85/:93`）另加 `defaultPrevented` 守卫。焦点恢复、agent 切换时的先后顺序都写成规则，并用真实 DOM 事件测试                                                                                                             | §6.4                              |
| 14  | major   | 验收矩阵缺时序场景；H1「取末条为 leaf」是错误的通过条件                      | 重写成 §10 时序矩阵（T/S/G/L/P/U 六组）；H1（现 F3）的验收改为「按 `finalLeafId` 回溯，末行是废弃分支时仍然正确」                                                                                                                                                                                                                                                                                                                                                                                          | §10                               |
| 15  | minor   | 行号锚点过时或错位                                                           | 以 HEAD 重新核对；改为「符号名 + 行号」两种写法并存                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 全文                              |
| 16  | minor   | 两个 Transcript 实例的状态隔离                                               | 新增 U-ISO 测试：主区与抽屉中 following、newCount、分页、窗口 start、DOM id 各自独立                                                                                                                                                                                                                                                                                                                                                                                                                       | §10 U7                            |
| 17  | nit     | 考虑把 gap 统一成定向的 `run_history` resync                                 | **采纳**。浏览器侧不再有 `run_gap` 事件，hub 遇到 gap 时自己发起一次重快照（single-flight），定向推 `run_history{resync:true}`。浏览器 SSE 事件从 4 个减到 3 个（`run_history`/`run_ev`/`run_end`）。agent→hub 之间保留 `run_gap`，因为尾部丢帧只有 agent 知道                                                                                                                                                                                                                                             | §3.3、§3.4                        |

**v2.1（复审第二轮：17 条中 15 条闭合，剩余 2 条主会话直接修掉）**：#4 `RegistryView` 接口明确追加 `getCaps(agentKey)`（§5.3 `hub/ports.ts` 条目）；#9 seq 起点统一为「计数器初值 0、首个事件 1」口径，`fromSeq:0` 冻结为 epoch 哨兵（§3.3 第 1 条）。复审其余 15 条确认闭合。

**已定项（用户裁定，复审不再讨论）**

- `webHub.subagentTranscript` 默认 `"all"`，见 §7.0。
- 768–1279px 使用覆盖式抽屉，不挤压主栏。
- 切换 agent 时立即退订当前选中的 run，不设宽限期。

---

## 0. 结论摘要

| 决策点     | 结论                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通道形态   | **混合**：按需拉取（快照和分页）；在抽屉里选中某个 run 后才订阅 live；没人看就不推                                                                                                                                               |
| 运行中 run | 数据来自 **agent 进程内**：子 `AgentSession` 与父 pi 同进程（`session-driver.ts:653` `SessionManager.create`、`:680` `createAgentSession`）。快照读内存 `getBranch()`，live 通过 `session.subscribe()` 挂一个 per-run `EventTap` |
| 终态 run   | **hub 读盘**：agent 回传 `sessionFile` 和 `finalLeafId`，hub 从文件尾部反向扫描，沿 leaf 回溯（§5.1），不阻塞 pi 和 hub 的事件循环                                                                                               |
| 帧         | agent↔hub：`run_tx_req`/`run_watch`（hub→agent），`run_tx_reply`/`run_ev`/`run_gap`/`run_end`（agent→hub）。浏览器 SSE：`run_history`/`run_ev`/`run_end`，**全部定向发送，不进 replay ring**                                     |
| 兼容门槛   | `PROTO` 升到 1.2（只加不改，major 不变）。agent 侧能力 `runtx.v1`/`runtx.lan.v1`，hub 侧能力 `runtx.v1`（`RUNTX_HUB_CAPS`），`AgentCard.runTranscript*`                                                                          |
| 关联键     | `runId`（`^r_[0-9A-HJKMNP-TV-Z]{8}$`，见 `core/ids.ts:10` `RUN_ID_RE`）。label 只用于显示                                                                                                                                        |
| 布局       | 抽屉放在 `AgentDetail` 内部，因为 `FleetActions` 依赖它 provide 的 `CONTROL_CTX`（`AgentDetail.vue:134`）。≥1280px 停靠，768–1279px 覆盖，<768px 全屏                                                                            |
| 浮层去留   | 删除 `FleetPanel.vue` 的浮层机制。树部分移到 `FleetTree.vue`，摘要行移到 `FleetSummaryBar.vue`。`FleetNode`/`FleetActions` 保留                                                                                                  |

---

## 1. 现状核对（HEAD `0d81592`）

- **fleet 行**：`FleetRowWire`（`protocol/messages.ts:87-102`，14 个字段），由 `projectFleet`（`agent/status.ts:57`）用 `buildFleetViewModel`（`ui/fleet-panel.ts:443`）投影。active 最多 64 行、terminal 最多 8 行（`status.ts:18-19`）。view-model 自己会算 `activeCount`/`shownActiveCount`/`totalCount`（`fleet-panel.ts:457-462`），但**目前没有投影到线上**（#12）。agent 每 1Hz 指纹比对后下发 `fleet` slot（`agent/index.ts:327-331`）。
- **子 agent 的增量**：只有 `RunDiagnostics` 里三个裁剪过的环形缓冲（`core/types.ts:797/838/848`），由它们生成 `streamLine`/`toolTrail`。会话文件路径是 `RunDiagnostics.sessionFile`（`core/types.ts:850`），在 `session_created` 时写入（`runner.ts:689-696`）。
- **终态封存点**：`RuntimeRunner.sealBeforeTerminal`（`runner.ts:488`）对每个 (runId, gen) 只执行一次，执行时 handle 仍在，并通过 `exit_facts` 元数据事件写诊断（`state-machine.ts:644`：仅对非终态打补丁，终态时不做任何事）。它的调用点覆盖了所有带 handle 的终态路径（`:532/:743/:826/:835/:839`）。
- **runner 的中央 dispatch**：`runner.ts:577-587`（reduce → `states.set` → `onStateChange` → effects），handle 表在 `:346`，清理在 `:894`（`activeHandles.delete`）。`RuntimeRunner` **没有 dispose**；stack 重建不会杀掉 run。
- **pi 落盘时机**：`SessionManager._persist`（`node_modules/.../session-manager.js:785-815`）要等出现第一条 assistant 消息才会写文件，之后每条 append 一行。`rememberAgents:false` ⇒ `SessionManager.inMemory`（`session-driver.ts:652-653`），完全没有文件。
- **`AgentSession.subscribe`** 返回取消订阅函数（`agent-session.js:801-810`）。
- **主会话 history**：浏览器 `POST /api/subscribe` → `runSnapshot`（`hub/http.ts:735`，pending 期间按对象身份守卫，见 `:746`）→ 定向发 `history` → 按 agentKey 作用域推 `ev`/`gap`/`append`（`scoped`，`:657`）。分页 `historyPage`（`:798`），每页最多 400 条（`HISTORY_PAGE_MAX`，`:115`），pending 缓冲上限 4096（`MAX_PENDING_FRAMES`，`:120`）。`statusFor`（`:216`）**没有** `E_UNSUPPORTED` 分支，会落到 500。`createRouteSet`（`:614`）被实例化两次：loopback 和 LAN 各一份。
- **hub 读盘**：`readBranchCached`（`history.ts:77`）走 realpath + `.jsonl` + 普通文件校验，**整份** `readFile` 后 `parseIndex`（`:117`）解析每一行。对 46.9MB 的文件，这一步会在主线程同步执行 JSON.parse（#8）。`walkBranch`（`:142`）从 leaf 沿 `parentId` 回溯。
- **连接层**：`HubConnection.send`（`agent/connection.ts:313`）返回 void，只有 `ev` 会 `markGap`；`writeRaw`（`:617`）遇到编码失败、写异常、超过 4 MiB 硬上限时静默结束；drain 时 `flushGap`（`:602`）。
- **SSE**：慢消费者直接 destroy（`sse.ts` 的 `write`/`drop`），浏览器重连后拿到**新的** clientId。
- **UI**：`DetailBody.vue:21-38` 是单列 flex；`FleetPanel.vue` 的浮层用 `document` 上的 pointerdown/keydown 监听（`:68-69`）和 `.tree-scroll`（`:89`，以及 `fleet.css` 的 absolute 定位 + z-index 20）。`DashboardView.vue` 在 `window` 上监听 keydown（`onKeydown`，`:85`，`:93` 注册）。`FleetActions.vue:74-77` 的 Esc 会 `stopPropagation`。`Transcript.vue:186` 把 `id="transcript"` 写死了。localStorage 有白名单（`tests/web-hub/ui/source-scan.test.ts:62-66`）。`REST_AUTH_PATHS`（`transport/password.ts:36-39`）只认 `/api/history` 前缀。

---

## 2. 通道选型（v1 结论保留，补充理由）

| 方案                | 问题                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A 纯推              | N 个 run 的 delta 发给所有浏览器（`sse.publish` 只按 agentKey 作用域）；挤占 16 MiB ring，主会话可补发窗口变短                                   |
| B 纯拉              | 只能轮询；每次重传最多 2 MiB；流式文本根本不落盘，拉不到                                                                                         |
| A′ 给 `ev` 加 runId | `ev` 是主会话自己的 seq 流（registry seq、prompts、history 缓冲与 delivered、gap 语义），混进来会污染这些语义，也会把子 agent 流量推给所有订阅者 |
| **C 混合（采用）**  | 看哪个推哪个；hub 引用计数；每个 run 只有一个 agent tap；hub 定向扇出                                                                            |

不走 cmd op：那是写路径，有 ledger/审计/在途上限，会污染 ctl 账本。不走 `/api/headless`：它的存在理由是「零 agent 也要能用」，而 transcript 必须依赖一个活着的 agent。

| run 状态               | 快照 / 分页                                                  | live                                        |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| 运行中，handle 在      | agent 内存 `getBranch()`，从尾部投影（`source:"live"`）      | 有：tap → `run_ev` … `run_end`              |
| 运行中，tap 已满（>8） | 同上                                                         | `watching:false` ⇒ 降级显示 `fleetActivity` |
| 终态                   | `source:"file"` + `sessionFile` + `finalLeafId`，由 hub 读盘 | 无                                          |
| 终态，无文件或 leaf    | 确定的 reason（§3.6）                                        | 无                                          |

---

## 3. 协议设计（冻结）

### 3.1 新文件 `src/web-hub/protocol/run-transcript.ts`

纯 TS + typebox，不 import `core/`（UI 也要用这个文件）。`RUN_ID_PATTERN` 用测试钉住，与 `core/ids.ts` 的 `RUN_ID_RE` 保持一致。

```ts
export const RUN_ID_PATTERN = "^r_[0-9A-HJKMNP-TV-Z]{8}$";
export const TAP_ID_PATTERN = "^[A-Za-z0-9_-]{8,32}$";
export const RUN_TX = {
  tailDefault: 200,
  pageMax: 400, // = HISTORY_PAGE_MAX
  maxBytes: LIMITS.branchReplyBytes, // 2 MiB / reply（单帧上限 4 MiB）
  tapsPerAgent: 8,
  subsPerClient: 2,
  reqDeadlineMs: TIMING.snapshotMs, // 5s
  clientPendingMs: 10_000, // 浏览器订阅 watchdog
  resyncMaxPer10s: 3,
  endPendingMax: 32,
  endPendingTtlMs: 10 * 60_000, // agent 侧
  endLedgerMax: 256,
  endLedgerTtlMs: 15 * 60_000, // hub 侧
  scanChunkBytes: 1 << 20,
  maxScanBytes: 256 << 20,
  scanConcurrency: 2,
  cursorCacheMax: 16,
} as const;

export const RUN_TX_REASONS = [
  "unknown_run",
  "not_persisted",
  "file_missing",
  "leaf_unknown",
  "leaf_missing",
  "too_large",
  "parse_error",
  "unsupported",
  "busy",
  "resync_storm",
] as const;
export type RunTxReason = (typeof RUN_TX_REASONS)[number];

// ---- hub→agent ----
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

// ---- agent→hub ----
export type RunTxReplyFrame =
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: true;
      source: "live";
      status: string;
      tapId?: string;
      seq: number; // seq = 快照 watermark；没有 tap 时为 0 且不带 tapId
      watching: boolean;
      entries: WireEntry[];
      truncated: boolean;
      hasMore: boolean;
      inflight?: InflightState;
    }
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: true;
      source: "file";
      status: string;
      sessionFile: string;
      finalLeafId: string;
    } // 这两个字段 hub 用完即剥离，绝不下发浏览器
  | {
      t: "run_tx_reply";
      rid: string;
      runId: string;
      ok: false;
      code: "E_NOT_FOUND" | "E_UNSUPPORTED";
      reason: RunTxReason;
    };
export interface RunEvFrame {
  t: "run_ev";
  runId: string;
  tapId: string;
  seq: number;
  e: WireEvent;
}
export interface RunGapFrame {
  t: "run_gap";
  runId: string;
  tapId: string;
  fromSeq: number;
}
export interface RunEndFrame {
  t: "run_end";
  runId: string;
  tapId: string;
  lastSeq: number;
  status: string;
}

// ---- 浏览器 ----
export interface RunHistoryPayload {
  agentKey: string;
  runId: string;
  entries: WireEntry[];
  tailMessages: WireMessage[]; // tailMessages 恒为 []，与 HistoryPayload 同构
  inflight?: InflightState;
  tapId?: string;
  fromSeq: number; // fromSeq = watermark + 1
  hasMore: boolean;
  oldestEntryId?: string;
  source: "live" | "file";
  terminal: boolean;
  status: string;
  live: boolean;
  resync?: true; // hub 主动发起的重快照（§3.3）
}
export interface RunHistoryError {
  agentKey: string;
  runId: string;
  error: "E_NOT_FOUND" | "E_UNSUPPORTED" | "E_BUSY" | "E_DEADLINE" | "E_AGENT_GONE";
  reason?: RunTxReason;
}
export interface RunEvPayload {
  agentKey: string;
  runId: string;
  tapId: string;
  seq: number;
  e: WireEvent;
}
export interface RunEndPayload {
  agentKey: string;
  runId: string;
  tapId: string;
  lastSeq: number;
  status: string;
}
export const RUN_SSE_EVENTS = ["run_history", "run_ev", "run_end"] as const;
export const RUN_API = {
  subscribe: "/api/run/subscribe",
  unsubscribe: "/api/run/unsubscribe",
  history: "/api/run/history",
} as const;
```

所有帧 schema 都是 `additionalProperties:false`。例外是 `entries[]` 和 `e`，沿用宽松信任姿态（`messages.ts` 文件头注释）。`run_tx_reply` 的三个分支互斥，写法照搬 `LanRes`（`messages.ts:977-996`）。

### 3.2 接入现有文件（只做追加，行号以 HEAD 为准）

- `protocol/messages.ts`：在 `AgentFrame`（`:322`）和 `HubFrame`（`:385`）两个联合类型里追加新帧；在 `agentFrameSchemas`（`:998`）和 `hubFrameSchemas`（`:1020`）两张表里各加几项，schema 从 `run-transcript.ts` import。`fleet` 帧和 `FleetFrameSchema` 追加可选的 `omitted?: { active: number; terminal: number }`（#12）。
- `protocol/version.ts`：`PROTO` 改成 `{1, 2}`（只比 major，见 `protoCompatible`）；新增 `RUNTX_AGENT_CAPS = ["runtx.v1","runtx.lan.v1"]`、`RUNTX_HUB_CAPS = ["runtx.v1"]`。
- `protocol/http-contract.ts`：`SSE_EVENTS` 追加 3 个事件；`AgentCard` 追加 `runTranscript?: boolean; runTranscriptLan?: boolean`。**不改 `API_ERRORS`**。
- `ui/src/logic/contract.js`：同步 `SSE_EVENTS`（同源 re-export，自动带上）；`API` 追加 `runSubscribe`/`runUnsubscribe`/`runHistory`（`:36-46`）。

兼容矩阵：

| 组合                              | 行为                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| 新 hub + 旧 agent（无 `runtx.*`） | card 不带 `runTranscript`；hub 拒绝 run 订阅（409 `unsupported`）；UI 只显示树        |
| 旧 hub + 新 agent                 | `hello_ack.caps` 不含 `runtx.v1`，agent 不启用 run 服务；收到未知帧也会被 decode 忽略 |
| 新 hub + 新 agent + 旧 UI 构建    | UI manifest 的 `proto.major` 没变，可以继续服务；旧 reducer 忽略未知事件              |

### 3.3 seq / gap / resync 协议（#9 #17 冻结）

**agent（每个 tap）**

1. 每次挂 tap 生成新的 `tapId`（12 字节 base64url）。`seq` 计数器初值 0（不占线），**每产生一个事件先 `seq++` 占号，再 `trySend`**——即线上首个合法 seq = 1（修订记录 #9「seq 从 1 开始」口径，二者同一语义）。`fromSeq:0` 仅为 registry epoch 变化哨兵（§5.2 bus 事件），永不对应任何真实 run seq。
2. `trySend` 结果不是 `"written"` ⇒ `firstMissing = min(firstMissing ?? seq, seq)`。
3. 只要 `firstMissing` 有值，每次 tick（1Hz）、link-up、以及下一次发送前，都尝试发**不可丢弃**的 `run_gap{fromSeq:firstMissing}`；写出成功才清空 `firstMissing`。gap 发出前又丢了事件，就合并取最小值。发 gap 期间**不暂停**后续事件的发送，下游自己用 watermark 过滤。
4. run 结束：先 `tap.flush()`，再按上面的规则补 gap，最后发 `run_end{lastSeq:seq}`（不可丢弃）。`run_end` 没写出 ⇒ 进入 `endedPending`（上限 32 条、TTL 10 分钟），之后在 tick 或 link-up 时按「gap 再 end」的顺序重试。**`run_end` 永远不能越过还没发出的 gap。**
5. 快照：同步执行 `tap.flush()`，读 `seq` 作为 watermark，再 `getBranch()`、`tap.inflight()`，回复 `seq=watermark` 和 `tapId`。

**hub（每个 RunWatch）** 维护 `{tapId?, lastSeq, contiguous, resync:{inFlight, again, times[]}, ended?}`。

| 输入                                                        | 条件                                                       | 动作                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `run_ev`                                                    | resync 进行中                                              | 原样缓冲到该 run 下所有 pending 订阅，不做连续性检查                                                                      |
| `run_ev`                                                    | `tapId` 不等于当前 tapId（且当前已知）                     | 触发 resync                                                                                                               |
| `run_ev`                                                    | `seq <= lastSeq`                                           | 丢弃（重复）                                                                                                              |
| `run_ev`                                                    | `seq > lastSeq + 1`                                        | 置 `contiguous=false`，触发 resync                                                                                        |
| `run_ev`                                                    | `seq === lastSeq + 1`                                      | `lastSeq=seq`，扇出给 live 订阅，缓冲给 pending 订阅                                                                      |
| `run_gap`                                                   | 任意                                                       | 触发 resync；如果 resync 已经在进行，且 `fromSeq` 大于在途快照的 watermark，就置 `again`，否则忽略（重复 gap 不额外放大） |
| `run_end`                                                   | `(tapId, lastSeq)` 已经在 ledger 里                        | 丢弃（agent 重试导致的重复）                                                                                              |
| `run_end`                                                   | `contiguous && lastSeq === end.lastSeq` 且没有 resync 在途 | 写入 ledger，扇出 `run_end`，标记 `ended`                                                                                 |
| `run_end`                                                   | 其他情况                                                   | 写入 ledger，触发 resync（快照会走终态 file 路径）                                                                        |
| `gap{fromSeq:0}`（epoch 变化）或 `session` 帧换了 sessionId | 该 agent 的所有 watch                                      | 重新发 `run_watch{on:true}`，然后全部 resync                                                                              |

**resync**（hub 主动发起，single-flight）：

1. 把该 run 下所有 live 订阅换成新一代的 pending 订阅（新 `RunSub` 对象，旧对象作废）。
2. 发 `run_tx_req`。
3. 拿到 reply 后，对每个仍然是同一对象的 pending 订阅：设 `lastSeq=watermark`、`contiguous=true`；定向发送 `run_history{resync:true}`；然后按到达顺序回放缓冲帧，丢掉 `seq<=watermark` 的，第一帧必须是 `watermark+1`，否则再 resync 一次。
4. 如果 `again` 被置位，再来一轮。
5. 10 秒内超过 3 次 ⇒ 给订阅者发 `run_history{error:"E_BUSY", reason:"resync_storm"}`，删除这个 watch，并发 `run_watch{on:false}`。

**浏览器** 维护 `runTx.{tapId, lastSeq}`：

- `run_history` 覆盖整个 runTx 状态，`lastSeq = fromSeq - 1`。
- `run_ev`：`tapId` 不一致或 `seq <= lastSeq` ⇒ 丢弃；`seq !== lastSeq + 1` ⇒ 重订阅（限速，复用 `resyncMinIntervalMs`，`useHub.ts:76`）。
- `run_end`：`lastSeq` 一致 ⇒ `terminal=true, live=false`；否则重订阅。

### 3.4 浏览器 HTTP / SSE 面

```
POST /api/run/subscribe   {clientId, agentKey, runId}  → 202 {ok:true}
     400 E_BAD_REQUEST（runId/字段不合法）· 404 E_NOT_FOUND（clientId/agentKey 未知）
     409 E_UNSUPPORTED{message:"unsupported"}（listener 对应 cap 缺失）· 503 E_BUSY{message:"busy"}（第 3 个不同的 run）
     → 定向 SSE：run_history（RunHistoryPayload | RunHistoryError），之后 run_ev / run_end
POST /api/run/unsubscribe {clientId, agentKey, runId}  → 200 {ok:true}（幂等，未订阅也返回 200）
GET  /api/run/history?agent=&run=&before=<entryId>&limit=<1..400>  → 200 RunHistoryPayload（纯 JSON；live 字段恒为 false）
     错误体 {error, message: RunTxReason}，状态码见 §3.6
```

- POST 请求走现有的 CSRF、64 KiB 上限和 deadline 管线；GET 与 `/api/history` 一样要求会话（LAN 走 `requireLanSession`）。
- 所有 `run_*` SSE 事件都用 `client.send()` **定向发送**，不调用 `sse.publish`，因此不进 ring、不消耗 event id。
- run 路由使用自己的 `RUN_HTTP_STATUS` 映射（400/404/409/410/503/504），不修改 `statusFor`：`statusFor` 没有 `E_UNSUPPORTED` 分支，会映射成 500。

### 3.5 run_end 可靠送达（#2）

| 丢失点                                  | 兜底                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| agent→hub link 断开或背压               | `endedPending` 重试（先发 gap 再发 end）；hub 端的 ledger 负责去重                                                      |
| agent 进程退出                          | hub 收到 `agent_down` ⇒ 给该 agent 下所有 run 订阅发 `run_history{error:"E_AGENT_GONE"}`                                |
| agent `/reload`（epoch 变化，tap 丢失） | hub 对所有 watch 做 resync；新模块按 runId 查询：run 仍在 registry ⇒ 拿到终态或运行中快照；run 不在了 ⇒ `unknown_run`   |
| hub 在 pending 期间收到 end             | 缓冲后与 history 一起按序下发                                                                                           |
| SSE 慢消费者被 destroy                  | 浏览器重连后拿到新 clientId，`hello` 之后重订当前选中的 run；ledger 中已有终态记录 ⇒ 快照强制走终态路径（不再挂 watch） |
| 订阅 202 之后迟迟收不到 history         | 浏览器 watchdog：`clientPendingMs`（10 秒）后重订阅，最多 2 次，然后进入 error 态并提供「重试」按钮                     |

### 3.6 终态错误与 UX（#10 冻结）

| reason          | 判定（谁、依据什么）                                                                   | 浏览器 code / HTTP  | 文案要点（i18n `drawer.reason.*`）                                           |
| --------------- | -------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `unknown_run`   | agent：`QueryService.get(runId)` 为 undefined（已被驱逐，或主会话切换后进了新 stack）  | E_NOT_FOUND / 404   | 该子 agent 已不在当前会话的记录中                                            |
| `not_persisted` | agent：已终态且 `diag.sessionFile` 为 undefined（`rememberAgents:false`）              | E_NOT_FOUND / 404   | 未持久化（rememberAgents=false），结束后对话不可回看                         |
| `file_missing`  | hub：`sessionFile` 有值但文件 ENOENT（典型情况：首条 assistant 前就失败，pi 还没落盘） | E_NOT_FOUND / 404   | 在首条回复前就结束了，没有可显示的对话；同时显示 fleet 行的状态和 phaseLabel |
| `leaf_unknown`  | agent：已终态但 `diag.finalLeafId` 为 undefined                                        | E_NOT_FOUND / 404   | 无法确定最终对话位置                                                         |
| `leaf_missing`  | hub：反向扫描到文件头也没找到 leaf                                                     | E_NOT_FOUND / 404   | 会话文件与记录不一致                                                         |
| `too_large`     | hub：超过 `maxScanBytes`                                                               | E_UNSUPPORTED / 409 | 会话文件过大，无法在 web 端显示                                              |
| `parse_error`   | hub：命中 leaf 链的那一行解析失败                                                      | E_UNSUPPORTED / 409 | 会话文件损坏                                                                 |
| `unsupported`   | hub：listener 对应的 cap 缺失                                                          | E_UNSUPPORTED / 409 | （UI 不显示入口；出现说明发生了竞态，显示通用提示）                          |
| `busy`          | hub：订阅超限，或扫描排队超时                                                          | E_BUSY / 503        | 稍后重试                                                                     |

- **不保留 bounded final snapshot**。理由：(a) 用户选择 `rememberAgents:false` 的意图就是不保留子会话；(b) 内存保留是新的增长点，需要额外的淘汰策略；(c) 正在 live 查看的浏览器已经拿到了全部内容：收到 `run_end` 后 runTx 进入 terminal，**不清空**已收到的条目；之后再翻页遇到 `not_persisted` 时，只禁用「加载更早」并显示提示。
- 首条 assistant 前就失败的 run：如果有人在 live 查看，live 期间看到的内容会保留；新打开的人看到 `file_missing`，并附带 fleet 行的状态。

---

## 4. agent 侧实现

### 4.1 runtime 读端口（包 F1）

**`final_leaf`（#1）**

- `core/types.ts`：session event 联合类型（`:479-548`，与 `exit_facts` 同族）追加 `| { t: "final_leaf"; leafId: string }`；`RunDiagnostics`（`sessionFile` 在 `:850`，`exitFacts` 在 `:854` 附近）追加 `finalLeafId?: string`。
- `core/state-machine.ts`：紧挨着 `exit_facts` 分支（`:644`），新增同形的分支：放在 generation 检查之后；终态时显式 no-op，状态对象引用相等；非终态时只给 `diag` 打补丁。按 AGENTS.md 的要求，状态机矩阵和属性测试同步更新（`tests/core/core.test.ts` 中 exit_facts 的 describe 块在 `:2522`，照抄出 final_leaf 的 P15a/P15b 两条用例）。
- `runtime/session-driver.ts`：`SessionHandle` 追加可选方法 `getLeafId?(): string | null`、`getBranchEntries?(): readonly unknown[]`、`observe?(l: (e: unknown) => void): () => void`。`PiSessionHandle` 分别用 `session.sessionManager.getLeafId()`、`getBranch()`（同类用法见 `:491/:519`）、`session.subscribe(wrapped)` 实现，`wrapped` 内部 try/catch 吞掉异常。
- `runtime/runner.ts` `sealBeforeTerminal`（`:488`）：在 `sealedGenerations.set` 之后、`sealSession` 之前，`try { const leaf = handleEntry.handle.getLeafId?.(); if (typeof leaf === "string") this.dispatchExternal(runId, gen, {kind:"session_event", at, event:{t:"final_leaf", leafId: leaf}}) } catch {}`。必须放在 `if (facts === undefined) return;` **之前**，否则没有 bash facts 的 run 会漏掉 leaf。
- 语义：final leaf =「run 的 prompt 落定那一刻的会话 leaf」。之后 reap 钩子如果再追加条目，这些条目一定是该 leaf 的后代，按 leaf 回溯时不会包含它们，结果是确定的。resume 场景下，新 run 的 leaf 是新 leaf，回溯会包含旧的历史，这是预期行为；旧 run 的 finalLeafId 仍然有效（文件只追加）。consult fork 的 sessionFile 是 fork 出来的那个文件，leaf 也在这个文件里。

**`observeRun`（#7）**

```ts
// runner.ts（新私有字段）
private readonly runObservers = new Map<string, { gen: number; set: Set<Obs> }>();
type Obs = { onEvent(e: unknown): void; onEnd(status: string): void; unsub?: () => void; done: boolean };

observeRun(runId, l): { kind: "attached"; detach(): void } | { kind: "terminal"; status: string } | { kind: "no_session" } | { kind: "unknown" }
peekRunBranch(runId): readonly unknown[] | undefined
```

- **线性化点**：在中央 `dispatch`（`runner.ts:577-587`）里，`this.states.set` 之后加判断：`wasTerminal === false && terminal(state.status)` ⇒ 调用 `endObservers(runId, gen, state.status)`。这是 run 进入终态的唯一时刻，单线程 JS 中不存在交错。
- **注册时**（同步完成，函数体内没有 await）：
  - `states.get(runId)` 不存在 ⇒ `unknown`；
  - 已终态 ⇒ `terminal`（同步返回，**不注册**）；
  - `activeHandles` 中没有这个 gen 的 handle（还在排队，或会话创建中）⇒ `no_session`；
  - handle 不支持 `observe` ⇒ 同样返回 `no_session`；
  - 否则注册：`unsub = handle.observe(e => !obs.done && safe(() => l.onEvent(e)))`，返回 `attached`。
- **恰好一次**：`endObservers` 和 finally 清理（`:894` 旁边，作为兜底）都会对每个 obs 执行「`if (obs.done) return; obs.done = true; safe(unsub); safe(() => l.onEnd(status))`」。`detach()` 只置 `done` 并取消订阅，**不调用 onEnd**。整个过程吞掉所有异常。
- late-arrival 的 handle 从不进入 `activeHandles` ⇒ 返回 `terminal` 或 `no_session`。session 被替换（stack 重建）时 runner 实例不变，清理责任在 web-hub 的 `RunTranscripts.dispose()`（§4.2），它会调用所有 `detach()`。
- 上限：每个 run 最多 16 个 observer（超出 ⇒ `no_session`），防止泄漏导致无限增长。

**透传层**：`service/ports.ts` 的 `Runner`（`steer?` 在 `:56`）追加 `peekBranch?`、`observe?`；`service/runtime-adapter.ts:1042` 附近透传；`service/query-service.ts`（`steer` 在 `:128`）追加 `branchOf?(id)`、`observe?(id, l)`，签名用 `unknown`，保持 I1。

### 4.2 `src/web-hub/agent/run-transcript.ts`（新，包 F2）

```ts
export interface RunTranscriptPort {
  info(runId: string): { status: string; terminal: boolean; sessionFile?: string; finalLeafId?: string } | undefined;
  branch(runId: string): readonly unknown[] | undefined;
  observe(
    runId: string,
    l: { onEvent(e: unknown): void; onEnd(status: string): void },
  ):
    | { kind: "attached"; detach(): void }
    | { kind: "terminal"; status: string }
    | { kind: "no_session" }
    | { kind: "unknown" };
}
export function createRunTranscripts(deps: {
  port: () => RunTranscriptPort | undefined;
  trySend: (f: AgentFrame, o?: { droppable?: boolean }) => SendResult;
  enabled: () => boolean; // hello_ack.caps 含 runtx.v1 且设置不为 off
  now: () => number;
  setTimer: (ms: number, fn: () => void) => { cancel(): void };
}): {
  onReq(f: RunTxReqFrame): void;
  onWatch(runId: string, on: boolean): void;
  onLink(live: boolean): void;
  tick(): void;
  dispose(): void;
};
```

- 每个 run 一条 tap 记录：`{runId, tapId, seq, firstMissing?, detach, tap: EventTap, ended?: {status}}`。tap 用 `createEventTap(sink, …)`（`agent/event-tap.ts`），复用它的 50ms delta 合并、250ms 工具节流、64 KiB 截断和 inflight 逻辑。`sink` 在发送前分配 seq（§3.3）。
- `onWatch(on:true)`：
  - 已经有 tap ⇒ 什么都不做（幂等）；
  - 总数已达 `tapsPerAgent` ⇒ 不挂 tap，之后的快照回 `watching:false`；
  - 否则调用 `port.observe`，结果是 `attached` 就建记录，`terminal`/`no_session`/`unknown` 就不建（快照会如实反映状态）。
- `onWatch(on:false)`：`detach()`，然后 `tap.dispose()`，删除记录；如果有 `endedPending` 也一并删除。
- `onReq`：
  - 只要 `info` 显示 terminal，就**无条件走 file 路径**，与 handle 是否还在无关，这样结果是确定的：
    - 没有 `sessionFile` ⇒ `not_persisted`；
    - 没有 `finalLeafId` ⇒ `leaf_unknown`；
    - 都有 ⇒ `source:"file"`。
  - 运行中：
    - 不带 `before`：先 `tap.flush()`，再按 §3.3 第 5 条做快照；`getBranch()` 从尾部往前逐条 `projectSessionEntry`，直到达到 `limit` 或 `maxBytes`（字节计法同 `agent/snapshot.ts:39-62`）。
    - 带 `before`：在 branch 中找到这个 id，往前切片；找不到 ⇒ `E_NOT_FOUND` + `leaf_missing`。
    - `branch()` 为 undefined（run 刚进入终态的竞态窗口）⇒ 重新读一次 `info`，按终态处理。
  - `info` 为 undefined ⇒ `unknown_run`。
- `tick()`：先补发 gap，再重试 `endedPending`，并淘汰其中 TTL 过期的项。
- `dispose()`：对所有 tap 执行 detach + dispose，清空 `endedPending`。触发时机：session 替换、web-hub 解除挂载、`/reload` 交接。

### 4.3 `connection.ts`：`trySend`（#6）

不改 `send()`，避免触碰所有测试替身和 `ev` 的既有行为。新增：

```ts
export type SendResult = "written" | "dropped" | "not_live" | "failed";
trySend(frame: AgentFrame, opts?: { droppable?: boolean }): SendResult;   // HubConnection 接口同步追加
```

| 情形                                                  | 返回       | 对 run 帧的含义                                |
| ----------------------------------------------------- | ---------- | ---------------------------------------------- |
| `link !== "live"` 或 socket 为 undefined              | `not_live` | 未写出，进入 `firstMissing` / `endedPending`   |
| `droppable && bufferedBytes > LIMITS.writeQueueBytes` | `dropped`  | 同上（只有 `run_ev` 是 droppable）             |
| `writeRaw` 编码失败                                   | `failed`   | 同上；同时 `console.warn` 一次（帧本身有问题） |
| `sock.write` 抛异常（触发 `onSocketDown`）            | `failed`   | 同上；link 进入 backoff，之后 link-up 补发     |
| 写入后超过 4 MiB 硬上限，socket 被拆除                | `failed`   | 按丢失处理（字节进了一个已销毁的 socket）      |
| 其他                                                  | `written`  | 已交给内核缓冲区                               |

- `writeRaw`（`:617`，私有方法）改为返回 `"written" | "encode_failed" | "socket_failed"`，现有调用方忽略返回值，行为不变。`send()` 的实现保持字节级不变。
- `BindingPort`（`:93`）追加可选的 `onRunTxReq?`/`onRunWatch?`；hub 帧的 switch 在 `case "branch_req"`（`:587`）旁边加两个 case，同样要求 `link === "live"`。
- `hello_ack.caps` 已经存在 `helloCaps` 中（`get caps()`），`enabled()` 读它判断。

### 4.4 接线（`agent/index.ts`、settings）

- `agent/index.ts`：
  - `binding`（`:400`）接上 `onRunTxReq`/`onRunWatch`；
  - `onStateChange`（`:452`）中调用 `runTx.onLink(v.state === "live")`；
  - fleet tick（`:327-331`）末尾调用 `runTx.tick()`，同时把 `projectFleet` 返回的 `omitted` 一起放进 `fleet` slot；
  - `capsExtra()`（`:506`）：`subagentTranscript` 为 `"all"` ⇒ 追加 `runtx.v1`、`runtx.lan.v1`；为 `"loopback"` ⇒ 只追加 `runtx.v1`；为 `"off"` ⇒ 都不追加。这一项**与 `control` 无关**（它是读面）；
  - `QueryControlPort`（`:96`）追加可选的 `branchOf?`/`observe?`，`QueryService` 在结构上自然满足；
  - session 替换或 dispose 时调用 `runTx.dispose()`。
- `agent/status.ts`：`projectFleet` 额外返回 `omitted = {active: vm.activeCount - vm.shownActiveCount, terminal: 终态总数 - 终态行数}`（`fleet-panel.ts:457-462`）；`fleetFingerprint` 也纳入 `omitted`。
- `config/settings.ts` + `config/setting-specs.ts`：`WebHubSettings` 追加 `subagentTranscript: "all" | "loopback" | "off"`，默认 `"all"`，非法值回退到默认。
- `src/index.ts`（`wireWebHub` 的调用在 `:859-865` 附近）**不需要改**。

---

## 5. hub 侧实现

### 5.1 `src/web-hub/hub/run-file-reader.ts`（新，包 F3a，不碰任何热点文件）——#8

```ts
export function createRunFileReader(opts?: { now?: () => number }): {
  read(
    file: string,
    leafId: string,
    q: { before?: string; limit: number; maxBytes: number; deadlineAt: number },
  ): Promise<
    | { ok: true; entries: WireEntry[]; hasMore: boolean }
    | { ok: false; reason: "file_missing" | "leaf_missing" | "too_large" | "parse_error" | "busy" }
  >;
  dispose(): void;
};
```

- **路径校验**：与 `readBranchCached`（`history.ts:77`）相同，realpath、`.jsonl`、`isFile()`，路径只来自 agent。
- **反向扫描**：用 `FileHandle.read` 从 EOF 开始，每次往前读 `scanChunkBytes`（1 MiB），拼接跨块的半行，按 `\n` 切分。维护 `want`（初始为 leafId）。对每一行先做 `line.includes('"id":"' + want + '"')` 子串预筛（JSON.stringify 输出的格式固定；`parentId`/`toolCallId` 里是大写 `I`，字符串内容里的引号会被转义，都不会误中），命中后再 `JSON.parse` 确认 `id === want`，然后 `projectSessionEntry`，把 `want` 换成 `parentId`。因为文件只追加，父条目一定出现在子条目之前，所以只需一次反向遍历。
- **结束条件**：已收集 `limit` 条（带 `before` 时，是在跨过 `before` 之后再收集 `limit` 条），或者字节预算用完，或者 `want === null`（到了根），或者到达文件头（还有 `want` 却到了文件头 ⇒ `leaf_missing`）。
- **让出事件循环**：每处理完一个块就 `await new Promise(setImmediate)`；`deadlineAt` 到了 ⇒ `busy`。累计扫描超过 `maxScanBytes`（256 MiB）⇒ `too_large`。
- **游标缓存**：LRU 16 条，key 为 `(realpath, size, mtimeMs, leafId)`，value 为 `{chain: WireEntry[] 新→旧, offset, carry, want}`。翻页请求先在 `chain` 里找 `before`，不够时从 `offset` 继续扫。文件被追加后 mtime 或 size 会变，key 失效，自然重扫。
- **single-flight**：同一个 key 同时只有一次扫描，并发请求共用同一个 promise；扫描完成后各自从 chain 中切片。
- **并发闸**：全局最多 2 个扫描同时进行，其余排队，以 `deadlineAt` 为限，超时 ⇒ `busy`。
- 对 46.9MB 的文件：取尾部 200 条快照，只需扫描到覆盖这 200 条的位置，一般只是文件的末尾一小段；最坏情况整份做子串扫描（引擎原生实现），每 1 MiB 让出一次。

### 5.2 `src/web-hub/hub/run-transcript.ts`（新，包 F3b）

```ts
export interface RunTranscriptService {
  snapshot(agentKey: string, runId: string, listener: "loopback" | "lan"): Promise<RunHistoryPayload>;
  page(
    agentKey: string,
    runId: string,
    before: string,
    limit: number,
    listener: "loopback" | "lan",
  ): Promise<RunHistoryPayload>;
  watch(agentKey: string, runId: string, ref: string): void; // ref = `${listener}:${clientId}`
  unwatch(agentKey: string, runId: string, ref: string): void;
  onFrame(agentKey: string, f: RunEvFrame | RunGapFrame | RunEndFrame): void;
  setSink(s: RunSink): void; // 由 http 层注入：resync / end / ev 扇出回调
  dispose(): void;
}
```

- **能力校验**（#4，hub 强制）：`snapshot`/`page`/`watch` 都先执行 `requireCap(agentKey, listener)`。`registry.getCaps(agentKey)`（`registry.ts:262`）必须包含 `runtx.v1`；listener 为 `lan` 时还必须包含 `runtx.lan.v1`；否则抛 `HubError("E_UNSUPPORTED", "unsupported")`。
- **watch 引用计数**：`Map<runKey, {refs:Set<ref>, …RunWatch}>`。refs 从空变成 1 ⇒ 发 `run_watch{on:true}`；从 1 变成空 ⇒ 发 `{on:false}`、删除 watch、取消 resync。**同一个 ref 重复 watch 不会重复计数。**
- **snapshot 顺序**：调用方必须先 `watch`，保证同一条 socket 上 `run_watch` 排在 `run_tx_req` 前面，快照时 tap 已经存在。拿到 reply 后分三种情况：
  - `source:"live"`：直接组装 payload；
  - `source:"file"`：调用 `reader.read(sessionFile, finalLeafId, …)`，payload 中 `terminal:true, live:false`，并剥离 `sessionFile` 和 `finalLeafId`；
  - `ok:false`：映射为 `HubError(code, reason)`。

  按字节截断时以实际的 SSE 帧为单位（与 `history.ts` 里 `buildCappedHistoryPayload` 的思路一致；新文件内实现一个小的 `capRunPayload`）。

- **RunEndLedger**（#2）：LRU 256 条、TTL 15 分钟，key 为 `agentKey|runId`，value 为 `{tapId, lastSeq, status}`。用途有两个：一是丢弃重复的 `run_end`；二是 (re)subscribe 时如果 ledger 中已有记录，就不挂 watch，直接走 snapshot（agent 会回 file 路径）。
- **bus 事件**：
  - `agent_down` ⇒ 通过 sink 对该 agent 的所有订阅推 `E_AGENT_GONE`，清空状态；
  - `gap{fromSeq:0}`（registry 在 epoch 变化时发出，`registry.ts:286-303`）或 `session` 帧的 sessionId 变化 ⇒ 重新 watch 并 resync；
  - caps 变化（重新 hello）⇒ 用新 caps 重新校验所有订阅，不再合格的发 `unsupported` 错误并退订。

### 5.3 现有文件的改动（包 F3b）

- `hub/history.ts`：**不改**。v1 打算加的 `lastId`/末行 leaf 已删除，读盘逻辑全部放在 `run-file-reader.ts`。
- `hub/registry.ts`：
  - `onFrame`：新增 `run_tx_reply` case，按 rid 结算 pending，写法与 `snapshot_reply`（`:402`）相同；新增 `run_ev`/`run_gap`/`run_end` case，发布到 bus；
  - `card()`（`:175` 附近）追加 `runTranscript: r.caps.includes("runtx.v1")`、`runTranscriptLan: r.caps.includes("runtx.lan.v1")`；
  - caps 在重新 hello 时更新（`:298`），之后发布 `{type:"caps", agentKey}` 事件（新增）。
- `hub/ports.ts`：`HubEvent` 追加 `run_ev`/`run_gap`/`run_end`/`caps` 四种事件；追加 `RunTranscriptService` 接口；`FrontendDeps` 追加可选的 `runTx?`；**`RegistryView` 接口追加 `getCaps(agentKey)`**（复审 #4：现有接口只有 `list`/`get`，run 路由与 §5.2 `requireCap` 依赖它——委托 `registry.ts:262` 的既有实现，`http.ts` 两处 `createRouteSet` 装配传入的 view 同步暴露，F4 验收含 typecheck + LAN/loopback 门控路由测试）。
- `hub/hub.ts`：组装 `createRunFileReader()` 和 `createRunTranscriptService({registry, reader, log})`，传给 frontend；`close()` 时 dispose，参考 upload 方案 #13 指出的「运行期 close 不执行 cleanup 数组」，需要**显式**调用。`HubInfo.caps`（`:227`）追加 `...RUNTX_HUB_CAPS`。
- `hub/agent-server.ts`：`hello_ack.caps`（`:153`）追加 `...RUNTX_HUB_CAPS`，与 `HubInfo.caps` 保持集合相等（§8.4 的测试）。
- `hub/http.ts` `toCard()`（`:338`）：照 upload 方案 #10 的先例，把 `runTranscript*` 两个字段加进白名单，并覆盖初始 `agents` 帧、`agent_up`、重连三条路径。

### 5.4 `src/web-hub/hub/run-routes.ts`（新）+ `http.ts` 接线（包 F4）——#3 #4

```ts
export function createRunRoutes(
  sse: SseHub,
  deps: {
    listener: "loopback" | "lan"; // 显式携带，决定 cap 要求和 ref 前缀
    registry: RegistryView;
    runTx: RunTranscriptService;
    log: HubLog;
    isClosed: () => boolean;
    now: () => number;
  },
): {
  subscribe(body: unknown, res: ServerResponse): void;
  unsubscribe(body: unknown, res: ServerResponse): void;
  historyPage(query: URLSearchParams, res: ServerResponse): Promise<void>;
  onClientClose(clientId: string): void;
  sink: RunSink; // 交给 runTx.setSink（loopback 与 LAN 各一份，service 内部按 ref 前缀路由）
};
```

**RunSub 代际**：`subs: Map<clientId, Map<runKey, RunSub>>`，其中 `RunSub = { gen: number; phase: "pending" | "live"; frames: Array<{event, data, seq?}>; overflow: boolean; resync: boolean }`。`gen` 在路由实例内单调递增，只用于日志和测试断言；**判等靠对象身份**。

| 操作 / 事件                             | 规则                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subscribe（新 run）                     | 依次校验：字段 → clientId 存在 → agentKey 存在 → cap（按 listener）→ 该 client 已有的不同 runKey 数小于 2（否则 503 `busy`）。新建 RunSub（pending），调用 `runTx.watch(ref)`，回 202，然后异步执行 `runTx.snapshot`                   |
| subscribe（同一 run 再来一次）          | 用**新对象**替换旧对象（旧对象的 snapshot 结果到达时因为身份不一致被丢弃）。不重复 watch。回 202，重新快照                                                                                                                             |
| snapshot 成功                           | 先检查 `subs.get(c)?.get(k) === sub` 且 SSE client 仍然存活，否则丢弃。然后依次：发 `run_history` → 按序回放 frames（丢弃 `seq <= watermark` 的帧）→ 如果 overflow 或期间被置了 resync 标记，则再发起一次 resync → 置 `phase = "live"` |
| snapshot 失败                           | 身份校验同上；发 `run_history{error, reason}`，删除 sub，执行 `unwatch`                                                                                                                                                                |
| unsubscribe                             | sub 存在 ⇒ 删除并 `unwatch`；不存在 ⇒ 无操作。始终回 200                                                                                                                                                                               |
| SSE close（`openEvents` 的 close 回调） | `onClientClose`：对该 client 的所有 sub 执行删除和 `unwatch`                                                                                                                                                                           |
| resync（sink）                          | 对该 run 的所有 live sub 换上新的 pending 对象，等 service 回调快照结果，再按上面「snapshot 成功」的流程处理                                                                                                                           |
| `run_ev` / `run_end`（sink）            | phase 为 live ⇒ `client.send`；为 pending ⇒ 放进 frames（达到 `MAX_PENDING_FRAMES` 置 overflow）。`client.send` 返回 false 时什么都不做：SSE 层已经 destroy 该连接，随后会触发 close                                                   |
| agent_down（sink）                      | 对所有 sub 发 `E_AGENT_GONE` 错误，然后删除                                                                                                                                                                                            |
| 再次 cap 校验失败（sink）               | 发 `unsupported` 错误并删除                                                                                                                                                                                                            |

**http.ts 接线**（尽量少改，因为 upload 和 spawn 都会动这个文件）：

- `createRouteSet`（`:614`）的 deps 追加 `listener`，以及可选的 `runTx`；内部按需创建 `createRunRoutes`。loopback 一侧（`:1836` 附近）传 `"loopback"`，LAN 一侧（`:1856` 附近）传 `"lan"`。
- loopback 的 `handleApi`：在 `:2133`/`:2141` 附近加三条路由。LAN 的处理函数：在 POST 区（`:1226` 附近）和 GET 区（`:1258` 附近）各加对应路由，都经过 `requireLanSession`。
- `openEvents` 的 close 回调（`:769`）里调用 `runRoutes.onClientClose(client.id)`。

---

## 6. UI 布局与状态

### 6.1 结构（改 `AgentDetail.vue:368-415` 的模板）

```
<main class="detail" :data-drawer="mode" :data-drawer-open="open || undefined">
  <DetailHeader/>
  <div class="detail-split">
    <div class="detail-main">  notices / ask_user / folded / skeleton | DetailBody / DetailDock  </div>
    <FleetDrawer v-if="hasFleet || selectedRunId" id="fleet-drawer"/>   ← 位于 CONTROL_CTX（:134）的 provide 作用域内
  </div>
</main>
```

### 6.2 三种模式（视觉由 CSS 决定，行为由 JS 决定）

| 模式       | 媒体查询           | 视觉                                                                                                        | 行为                                                                                               |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| docked     | ≥1280px            | `.detail-split{grid-template-columns:minmax(0,1fr) var(--drawer-w)}`，`--drawer-w: clamp(360px,30vw,520px)` | 开合状态存 localStorage（`webhub.fleetDrawer.open`，默认 `"1"`）；不做焦点陷阱；没有键盘或指针监听 |
| overlay    | 768–1279px（已定） | `position:absolute; inset-block:0; right:0; width:min(420px,85%); z-index:30`                               | 每次挂载都是关闭状态，不持久化；Esc 或点击外部关闭（§6.4）；`role="dialog"`                        |
| fullscreen | ≤767px             | `position:fixed; inset:0; z-index:40`（低于 `base.css` 跳转链接的 50）                                      | 同 overlay；树和 transcript 只显示其一，用「← 子 agent 列表」返回                                  |

模式判定通过 `useMedia(window, "(min-width:1280px)")` 和 `useMedia(window, "(max-width:767px)")`。

### 6.3 FleetPanel 迁移与可见性（#12）

| 现状                                                                       | 去向                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FleetPanel.vue` 的 summary 摘要行                                         | `fleet/FleetSummaryBar.vue`：一行，常驻文档流，是一个 `<button aria-controls="fleet-drawer" :aria-expanded>`。docked 且已打开时由 CSS 隐藏                                                                           |
| 树列表与「Show N Finished」                                                | `fleet/FleetTree.vue`；底部新增「另有 N 个运行中 / M 个已结束未列出」（数据来自 `a.fleetOmitted`，即 `fleet` 帧的 `omitted`）                                                                                        |
| 浮层机制（`FleetPanel.vue:68-69` 的监听、`.tree-scroll` 的 absolute 定位） | **删除**；`.tree-scroll` 改为静态滚动容器                                                                                                                                                                            |
| `FleetNode.vue` 的 activity（`:37-42`）                                    | 抽成 `fleet/summary.ts` 的 `fleetActivity(row) = streamLine \|\| toolTrail`（clip 160）。`FleetNode` 和 RunTranscript 的降级页脚共用                                                                                 |
| `FleetNode.vue` 的 `run-name`（`:90`/`:146`）                              | 包一层 `<button class="run-open">`，`@click.stop.prevent` ⇒ `FLEET_SELECT.select(runId)`。只有在 `card.runTranscript` 为真（LAN 下看 `runTranscriptLan`）时才渲染为按钮，否则保持纯文本；`⋯` 和 `FleetActions` 不动  |
| 父 run 未列出                                                              | `logic/fleet.js` 的 `fleetTree` 本来就会把父节点不存在的行提升为根（`present.has(p)` 判断）。`tree.ts` 额外标记 `orphan: row.parentRunId !== undefined && 父节点不在 rows 中`，`FleetNode` 显示「父 run 未列出」chip |
| 被选中的 run 移出 rows                                                     | `runTx.lastRow` 保留最后一次看到的 `FleetRowWire`，抽屉头部继续显示，并加上「不在列表中」标记；transcript 照常工作（按 runId 查询，不依赖 rows）                                                                     |
| `contracts.ts` 的 `FleetPanelProps`（`:236-240`）                          | 替换为 `FleetTreeProps`、`FleetSummaryBarProps`、`FleetDrawerProps`、`RunTranscriptProps`。这是对 P0 冻结面的**有意修订**，在 PR 中写明                                                                              |

### 6.4 键盘、指针与焦点契约（#13）

1. **唯一的 owner**：只有 `FleetDrawer` 注册文档级监听，并且只在 `mode !== "docked" && open` 时注册（通过 watch 动态注册和移除）：`document.addEventListener("keydown", onKey)`（**bubble 阶段**）和 `document.addEventListener("pointerdown", onPointer)`。`FleetPanel` 原有的两个监听随文件一起删除。
2. **事件顺序**：目标元素上的处理器先执行（例如 `FleetActions.vue:74-77` 的 Esc 解除武装会 `stopPropagation`，抽屉收不到，这是期望的行为），然后到 `document`（抽屉），最后到 `window`（`DashboardView.vue:93`）。
3. `onKey`：`ev.key !== "Escape"`、`ev.isComposing`、`ev.defaultPrevented`，或者目标是 input/textarea/select（规则与 `DashboardView.vue:85-91` 相同）⇒ 直接返回。否则 `ev.preventDefault(); ev.stopPropagation(); close()`。
4. `DashboardView.onKeydown` 在开头追加 `if (ev.defaultPrevented) return;`，作为双保险（这是 spawn SP10 也会碰的文件，见 §8.3）。
5. `onPointer`（仅 overlay 模式）：目标在抽屉内部，或者在 `FleetSummaryBar` 的按钮上 ⇒ 忽略（避免「先关闭再被重新打开」）；否则关闭。fullscreen 模式下抽屉占满全屏，不存在「外部」。
6. **焦点**：打开时，焦点移到抽屉的关闭按钮。关闭时，焦点还给 `FleetSummaryBar` 的按钮；如果它不在 DOM 中，就还给主区的 `#transcript`。docked 模式下打开或关闭都不移动焦点。
7. **切换 agent 的顺序**（切换时立即退订，已定）：hash 变化 → reducer 处理 `select` → `useHub` 的副作用：先 `runUnsubscribe(旧 agent 的 run)`，再执行既有的 `unsubscribe(旧 agent)`（`useHub.ts:114-122 `runEffects``）→ Vue 重渲染，卸载旧 `AgentDetail`（它以 `:key` 绑定 agent）→ `FleetDrawer` 的 `onBeforeUnmount` 同步移除监听，**不调用 transport**。run 订阅只归 `useHub` 管。

### 6.5 状态管理与 transport（#11）

- `logic/state.js`：`AgentState` 追加 `runSel: string | null`、`runTx: RunTxState | null`、`fleetOmitted?`。其中 `RunTxState = {runId, tapId?, lastSeq, items, keys, entryIds, uid, streaming, tools, history, historyError?, reason?, hasMore, oldestEntryId?, paging, terminal, status, live, source, pendingSince?, retries, lastRow?}`。
  - 从 `applyHistory`（`:593`）、`applyPage`（`:639`）和 `applyEvent`（`:749`）中抽出只依赖 `{items, keys, entryIds, uid, streaming, tools, …}` 的内核，主会话和 run 共用，主会话行为不变，由 `logic-state.test.ts` 保证。
  - 新增 case：`run_select`、`run_subscribing`、`run_history`、`run_ev`、`run_end`、`run_paging`/`run_page`/`run_page_failed`、`run_unsubscribed`。`runId` 不匹配的一律丢弃，seq 规则见 §3.3。
- `composables/useHub.ts`：新增 `selectRun(agentKey, runId | null)`、`pageRun(agentKey)`；维护 `runSubs: Set<runKey>`，记录本 tab 认为自己已订阅的 run。
  - **订阅 watchdog**：pending 超过 `clientPendingMs` ⇒ 重订阅，`retries` 加 1；超过 2 次 ⇒ 进入 error 态（`history:"error"`，显示重试按钮）。
  - **`E_BUSY`**：先对 `runSubs` 中所有不是当前选中的 runKey 调用 `runUnsubscribe`，再重试一次；仍然失败就进入 error 态。
  - **SSE `hello`**（clientId 变了）：清空 `runSubs`；如果当前 agent 有 `runSel`，就重新订阅，期间 runTx 保留已有内容，并显示「重新连接中」角标。
- **transport**（`transport/types.ts:66` 的 `HubTransport` 追加三个**可选**方法 `runSubscribe?`/`runUnsubscribe?`/`runPage?`）：

| 方法           | token（`logic/token-client.js`）                                            | password（`logic/password-client.js` + `transport/password.ts`）                  |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| runSubscribe   | `withRelogin(() => postRaw(API.runSubscribe, …))`，同 `subscribe`（`:281`） | `postApi`；401 ⇒ `onConn("auth")`（把 `API.runSubscribe` 加进 `REST_AUTH_PATHS`） |
| runUnsubscribe | 发出即不管，吞掉失败（同 `unsubscribe`，`:288-290`）                        | 同左；401 ⇒ `onConn("auth")`（把 `API.runUnsubscribe` 加进 `REST_AUTH_PATHS`）    |
| runPage        | `withRelogin(() => request(GET))`                                           | `isRestAuthEndpoint` 增加 `url.startsWith(API.runHistory)` 判断                   |

`REST_AUTH_PATHS`（`transport/password.ts:36`）同时也是 upload 方案的热点（§8.3）。

### 6.6 RunTranscript 与 Transcript 复用

- `TranscriptProps.agent` 收窄为 `TranscriptSource = Pick<AgentState, "key"|"items"|"streaming"|"tools"|"history"|"historyError"|"hasMore"|"paging">`；`buildTxEntries`（`entries.ts:176`）和 `indexTools`（`tool-index.ts:27`）同步收窄。
- `Transcript.vue` 新增可选 prop `anchorId`，默认 `"transcript"`，替换 `:186` 写死的 id；抽屉中传 `"run-transcript"`。
- `RunTranscript.vue`：
  - 用 `provide(CONTROL_VIEW, null)` 覆盖 `AgentDetail` 的 provide（`:129`），使 `TxUser` 的 web 徽标不出现；
  - 自己持有 `following`/`newCount`，带一个迷你「↓ 最新」按钮；
  - `live === false && !terminal` 时，页脚显示 `fleetActivity(lastRow)` 和降级原因（`watching:false` ⇒「实时更新名额已满」）；
  - `terminal` 时页脚显示终态 chip；
  - 出错时按 §3.6 的 reason 显示文案。

---

## 7. 安全与权限

### 7.0 威胁模型与已接受风险（#4，**用户裁定**）

> 本节记录用户决策：`webHub.subagentTranscript` 默认取 `"all"`，LAN 明文模式下也开放。复审不再讨论默认值；要改，须用户重新拍板。依据：与主会话 transcript 同级，并与 upload 方案 blocker #1 的裁定一致。

- **资产**：子 agent 的消息、工具调用参数和工具结果。其中常有大段 `read` 输出，可能包含源码、配置，偶尔有密钥类文件内容。
- **LAN 明文（password 模式 + `http:`）下已接受的风险**：同网段攻击者能嗅探到完整的子 agent transcript。暴露面与已经开放的主会话 transcript、prompt 文本同级（参见 `lan-plan.md` 的明文裁定）；只读，不新增写能力。
- **缓解**：
  - `"loopback"` 档：agent 只声明 `runtx.v1`，hub 的 LAN 路由强制要求 `runtx.lan.v1`，因此被拒；
  - `"off"`：全局关闭；
  - 在 HTTPS 反向代理后面部署时，明文问题不存在；
  - 会话文件路径永远不下发给浏览器；
  - 浏览器只能提交 `agentKey` + 符合 `RUN_ID_PATTERN` 的 runId。
- **不在范围内**：同 uid 下的本地恶意进程；transcript 内容本身带来的 prompt injection（与主会话相同）。

### 7.1 工程约束（#4 工程部分）

1. **门控在 hub 侧强制，不依赖 UI 或 card**：`requireCap(agentKey, listener)` 在 subscribe、page、watch 三处都要检查，在 caps 变化时还要再校验一次（§5.2）。
2. agent 侧按设置决定声明哪些 cap（§4.4），这是第一层。hub 侧按 listener 检查，这是第二层。UI 隐藏入口，这是第三层，只为体验，不承担安全职责。
3. 资源上限：
   - 每个 client 最多 2 个 run 订阅；
   - 每个 agent 最多 8 个 tap；
   - 单个 reply 不超过 2 MiB；
   - 扫描并发 2、扫描上限 256 MiB；
   - resync 风暴熔断；
   - LAN 侧另有 conn-guard 的在途配额。
4. 读操作不写审计日志，与 `/api/history` 一致。child session 不受影响：web-hub 是 post-guard 接线，tap 只挂在父进程持有的 subscribe 上，只读，不改 payload。

---

## 8. 拆包、依赖与合入纪律

### 8.1 包表

| 包                  | 文件域                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 热点 | 依赖                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------- |
| **F0 协议**         | `protocol/run-transcript.ts`（新）、`protocol/messages.ts`、`protocol/version.ts`、`protocol/http-contract.ts`、`ui/src/logic/contract.js`；测试 `tests/web-hub/protocol/run-transcript.test.ts`（新）、`messages.test.ts`、`version.test.ts`、`tests/web-hub/contract/types.test-d.ts`、`tests/web-hub/ui/logic-contract.test.ts`                                                                                                                                                                                                                                                                                   | 是   | spawn SP11 已合入                              |
| **F1 runtime**      | `core/types.ts`、`core/state-machine.ts`、`runtime/session-driver.ts`、`runtime/runner.ts`、`service/ports.ts`、`service/runtime-adapter.ts`、`service/query-service.ts`；测试 `tests/core/core.test.ts`（final_leaf 分支）、`tests/runtime/runner-observe.test.ts`（新，真实 `RuntimeRunner`）、`tests/runtime/session-driver.test.ts`、`tests/service/query-service-transcript.test.ts`（新）                                                                                                                                                                                                                      | 否   | 无（随时可开工）                               |
| **F2 agent**        | `web-hub/agent/run-transcript.ts`（新）、`agent/connection.ts`、`agent/index.ts`、`agent/status.ts`、`config/settings.ts`、`config/setting-specs.ts`；测试 `tests/web-hub/agent/run-transcript.test.ts`（新）、`connection.test.ts`、`wiring-control.test.ts`、`tests/config/web-hub-settings.test.ts`                                                                                                                                                                                                                                                                                                               | 是   | F0；F1 只需要接口（测试用假 port）             |
| **F3a 读盘器**      | `hub/run-file-reader.ts`（新）；测试 `tests/web-hub/hub/run-file-reader.test.ts`（新）、`run-file-reader.perf.test.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   | 无（随时可开工，只需要 `projectSessionEntry`） |
| **F3b hub 服务**    | `hub/run-transcript.ts`（新）、`hub/registry.ts`、`hub/ports.ts`、`hub/hub.ts`、`hub/agent-server.ts`、`hub/http.ts`（**只改** `toCard`）；测试 `tests/web-hub/hub/run-transcript.test.ts`（新）、`registry.test.ts`、`hub.test.ts`、`agent-server.test.ts`、`tests/web-hub/hub/caps-coexist.test.ts`（新）                                                                                                                                                                                                                                                                                                          | 是   | F0、F3a                                        |
| **F4 hub HTTP**     | `hub/run-routes.ts`（新）、`hub/http.ts`（routeSet 和路由）；测试 `tests/web-hub/http/api-run.test.ts`（新）、`lan-run.test.ts`（新）、`sse.test.ts`、`security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                             | 是   | F3b                                            |
| **F5 UI 逻辑/传输** | `ui/src/logic/state.js`、`logic/token-client.js`、`logic/password-client.js`、`ui/src/transport/{types,token,password}.ts`、`composables/useHub.ts`、`ui/src/types.ts`；测试 `logic-state.test.ts`、`logic-run-tx.test.ts`（新）、`transport-contract.test.ts`、`use-hub.test.ts`                                                                                                                                                                                                                                                                                                                                    | 是   | F0                                             |
| **F6 UI 抽屉**      | `components/drawer/{FleetDrawer,RunTranscript,RunHeader}.vue`（新）、`components/fleet/{FleetTree,FleetSummaryBar}.vue`（新）、`fleet/summary.ts`（新）、删除 `FleetPanel.vue`、`FleetNode.vue`、`fleet/tree.ts`、`body/DetailBody.vue`、`detail/AgentDetail.vue`、`transcript/{Transcript.vue,entries.ts,tool-index.ts}`、`shell/DashboardView.vue`（只加一行 `defaultPrevented` 守卫）、`contracts.ts`、`styles/drawer.css`（新）、`styles/fleet.css`、`styles/detail.css`、`i18n/{en,zh}/drawer.ts`（新）、`i18n/index.ts`；测试见 §10 U 组，另有 `source-scan.test.ts`（白名单 + canary）、`i18n-parity.test.ts` | 是   | F5（布局部分可先用桩）                         |
| **F7 验收**         | `docs/dev/web-hub-fleet-drawer/acceptance.md`（新）、`AGENTS.md`（`src/web-hub/` 条目追加一句）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 否   | 全部                                           |

### 8.2 并行图

```
F1 ───────────────┐            （随时可开工，零热点）
F3a ──────────┐   │            （随时可开工，零热点）
  [闸门：spawn SP11 已合入 master]
F0 ─┬─► F2 ───┼───┴──────────┐
    ├─► F3b ◄─┘ ─► F4 ───────┤
    └─► F5 ─► F6 ────────────┴─► F7
```

### 8.3 合入纪律（#5）

**唯一合入顺序**：**upload（U1→U5）→ spawn（SP1→SP11）→ fleet（F0→F7）**。upload 已评审通过，正在开发；spawn 排在 upload 之后。

1. fleet 的热点包（F0、F2、F3b、F4、F5、F6）开工前，执行者必须在包的开头贴出下面命令的结果：

   ```sh
   git fetch && git switch master && git pull --ff-only
   git log --oneline -1 --grep "SP11" master        # 必须有输出：spawn S1 已合入
   git status --porcelain -- src/web-hub tests/web-hub src/config   # 必须为空：不得有他人未提交的改动
   git merge-base --is-ancestor "$(git log -1 --format=%H --grep SP11 master)" HEAD && echo based-ok
   ```

   如果第二或第四条没有输出，就**不得开工**。fleet 内部的后续包，也只能基于前一个包的最新合入提交开工，例如 F4 基于 F3b 的合入提交。

2. F1、F3a 不碰热点文件，可以提前开工，但合入前要检查 `git diff --name-only master...` 不包含下表里的任何文件。
3. 热点文件的 owner 与合并点：

| 共享文件                                                                                                                | upload                   | spawn             | fleet            | 合并点 / 规则                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `protocol/version.ts`                                                                                                   | U1（`UPLOAD_*_CAPS`）    | SP1               | F0               | PROTO 的 minor 由**本方案 F0** 升到 1.2；如果 spawn 已经升过，就再加 1，并在 F0 中说明 |
| `protocol/http-contract.ts`                                                                                             | U1（API_ERRORS、card）   | SP1（`:39,68`）   | F0               | 只追加；fleet 不碰 `API_ERRORS`                                                        |
| `protocol/messages.ts`                                                                                                  | —                        | SP1               | F0               | schema 本体放在独立文件，这里只改联合类型和两张 schema 表                              |
| `hub/registry.ts` `card()`                                                                                              | U1                       | —                 | F3b              | 在相邻行追加                                                                           |
| `hub/http.ts`                                                                                                           | U1（toCard）/U3          | SP7               | F3b（toCard）/F4 | 逻辑放进 `run-routes.ts`，http.ts 只改十几行                                           |
| `hub/ports.ts`                                                                                                          | U3                       | SP1               | F3b              | 只追加                                                                                 |
| `hub/hub.ts`、`hub/agent-server.ts`                                                                                     | U3（`:227`/`:153` caps） | SP2/SP8           | F3b              | caps 一致性由 §8.4 的测试守住                                                          |
| `agent/index.ts`（`capsExtra` 和 binding）                                                                              | U1                       | SP2（`:484-505`） | F2               | 三方都改 `capsExtra`，严格按顺序                                                       |
| `config/settings.ts`、`setting-specs.ts`                                                                                | U1                       | SP2               | F2               | 只追加                                                                                 |
| `ui/transport/*`、`logic/{token,password}-client.js`、`logic/contract.js`、`ui/types.ts`、`useHub.ts`、`logic/state.js` | U4                       | SP9               | F5               | 方法都是可选追加；`REST_AUTH_PATHS` 由 U4、SP9、F5 依次追加                            |
| `components/shell/DashboardView.vue`                                                                                    | —                        | SP10（`:48`）     | F6               | fleet 只加一行守卫                                                                     |
| `tests/web-hub/agent/wiring-control.test.ts`、`tests/web-hub/http/api.test.ts`、`tests/web-hub/hub/registry.test.ts`    | U1                       | SP2/SP7           | F2/F3b           | 只追加 describe 块，不改已有块                                                         |
| `tests/web-hub/ui/source-scan.test.ts`                                                                                  | —                        | ?                 | F6               | 白名单只追加 `drawer/FleetDrawer\.vue`                                                 |

### 8.4 三方能力共存测试（#5，F3b 负责）

`tests/web-hub/hub/caps-coexist.test.ts`（新）：

1. 用 hub 测试 helper 起一个真实 hub，取 `HubInfo.caps`（SSE `hub` 帧，对应 `hub/hub.ts:227`）和 `hello_ack.caps`（`agent-server.ts:153`）。断言两者**集合相等**，且包含 `P2_HUB_CAPS ∪ UPLOAD_HUB_CAPS ∪ RUNTX_HUB_CAPS`；如果 spawn 定义了 hub 能力，也一并纳入。
2. agent 的 hello caps 组合：`control{true,false} × uploads{on,loopback,off} × subagentTranscript{all,loopback,off}`，共 18 种。用 `wiring-control` 的 harness 断言预期集合；特别是 `control:false` 时仍然声明 `runtx.*`，但不声明 `upload.*`。
3. registry 的 card：`upload`/`uploadLan`/`runTranscript`/`runTranscriptLan` 四个字段相互独立，并且在初始 `agents` 帧、`agent_up`、重连三条路径上的取值一致。

---

## 9. 各包验收（统一要求：`npm run typecheck` 通过，列出的 vitest 用例全绿，相关包还要求 `npm run build:web` 通过）

- **F0**：每个新帧都有正例和反例；`run_tx_reply` 三个分支互斥；超过 4 MiB 的帧拒收；`RUN_ID_PATTERN` 与 `isRunId` 在 1k 个随机样本上结论一致；旧帧解码零回归；`fleet.omitted` 可选、能正确往返；`logic-contract` 测试通过。
- **F1**：
  - `final_leaf` 分支：非终态时打补丁；终态时返回引用相等的同一对象；generation 过期时只增加 `staleInputs`；
  - `sealBeforeTerminal` 在 bash facts 为 undefined 时仍然写入 leaf；
  - `observeRun` 覆盖 §4.1 的全部分支；`onEnd` 在「终态 dispatch」和「finally」两条路径上都只触发一次；`detach` 不触发 `onEnd`；listener 抛异常不影响 run 的结果；observer 上限生效；late-arrival 的情形；
  - `tests/core`、`tests/runtime`、`tests/service` 全绿，状态机矩阵同步更新。
- **F2**：§10 S1–S6 中 agent 侧的那一半（用假 port + 假 `trySend`）；`trySend` 结果表的每一行（用真实 `HubConnection` + 假 socket）；`send()` 的 `ev` 行为字节不变（既有 connection 测试全部通过）；快照在同一 tick 内对齐；尾部投影的 limit 和字节上限；终态无条件走 file 路径，以及 `not_persisted`/`leaf_unknown`/`unknown_run` 三种错误；tap 上限 ⇒ `watching:false`；`dispose` 后不再发出任何帧；18 种 caps 组合。
- **F3a**：T1–T6（真实临时 jsonl 文件，包括「末行属于废弃分支」）；P1–P5；`before` 翻页；子串预筛不会误中（构造 `parentId`、`toolCallId`、正文里含 `"id":` 转义串的样本）；跨块半行；尾部有截断行的文件。
- **F3b**：
  - 引用计数在 0→1、1→0 时各只发一次 watch；watch 在 req 之前发出；
  - file 源**按 `finalLeafId` 回溯**，末行属于废弃分支时结果依然正确（这一条替代 v1 的错误验收条件）；
  - payload 中不出现 `sessionFile`/`finalLeafId`；
  - §3.3 hub 状态表的每一行；RunEndLedger 的去重和 TTL；
  - agent_down、epoch 变化、caps 变化三种事件的处理；
  - L1–L10 中服务层的那一半；caps-coexist 测试；主会话 `history.test.ts` 零回归。
- **F4**：G1–G9、L1–L10（真实 HTTP，两个 listener 都测）；run 事件不进 ring（用 `Last-Event-ID` 重放，结果里没有 `run_*`）；401/403 正确；`RUN_HTTP_STATUS` 映射正确。
- **F5**：主会话 reducer 零回归；`run_*` 状态转换；seq 规则（丢弃、发现空洞后重订）；watchdog；`E_BUSY` 自愈；`hello` 后重订；两种 transport 的 run 方法行为对称，401 矩阵见 U12。
- **F6**：U1–U13；`source-scan`；`i18n-parity`；`build:web`；`ui-manifest`。
- **F7**：tmux 真机验收，执行 §10 中标「真机」的场景；CI 四件套 + `build:web` 全绿。

---

## 10. 时序与验收矩阵（#14）

**T 终态 leaf（F3a/F3b/F1）**

| #   | 场景                                                                    | 判据                                                                            |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T1  | 线性会话                                                                | 与 `walkBranch(finalLeafId)` 的结果逐条相等                                     |
| T2  | 文件末尾几行属于另一个分支（手工构造 branch：从中途的条目再长出一条链） | 按 finalLeafId 回溯；**不包含**末行所在分支                                     |
| T3  | 包含 compaction 条目                                                    | compaction 条目出现在链上，顺序正确                                             |
| T4  | consult fork 文件（带 `parentSession` 头）                              | 只读 fork 文件自身的链                                                          |
| T5  | `Agent({resume})`：旧 run A 与新 run B 共用同一个文件                   | A 显示到 A 的 leaf 为止；B 包含 A 的历史以及 B 新增的部分                       |
| T6  | child `switch_context` 的边界草稿                                       | 与运行中通过 `getBranch()` 看到的链一致（同一个 leaf 下 live 与 file 结果相等） |
| T7  | `diag.finalLeafId` 缺失                                                 | `leaf_unknown`，绝不回退到末行                                                  |
| T8  | 首条 assistant 前就失败（文件从未创建）                                 | `file_missing`；UI 显示状态和 phaseLabel（真机）                                |
| T9  | `rememberAgents:false` 的 run 结束                                      | 新打开 ⇒ `not_persisted`；之前已在 live 查看的视图保留内容（真机）              |

**S seq/gap/end（F2/F3b/F5）**

| #   | 场景                                         | 判据                                                                                               |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S1  | 连续事件                                     | 浏览器状态 = 由 `getBranch()` 投影得到的真值                                                       |
| S2  | 运行中途 `dropped`                           | agent 发出 `run_gap(fromSeq = 第一个丢失的 seq)`；hub 发起 resync；最终状态 = 真值                 |
| S3  | resync 在途时又收到重复的 `run_gap`          | 最多额外再 resync 一次                                                                             |
| S4  | gap 之后紧接着 end                           | hub 不直接转发 end，而是做终态 resync，最终 `terminal:true`                                        |
| S5  | run 结束时 link 断开                         | `endedPending` 生效；relink 后依次发出 gap 和 end；浏览器不会卡在 pending（真机：kill hub socket） |
| S6  | agent 重试导致 `run_end` 重复                | 被 ledger 丢弃，浏览器只收到一次                                                                   |
| S7  | seq 跳号或乱序（注入）                       | 由 hub 检测并 resync                                                                               |
| S8  | live 期间 agent 执行 `/reload`（epoch 变化） | 触发 resync，结果是 `unknown_run` 或新快照（真机）                                                 |
| S9  | 10 秒内超过 3 次 resync                      | `resync_storm` 错误，watch 被清理                                                                  |
| S10 | hub 未能察觉、浏览器自己发现空洞             | 浏览器重订阅                                                                                       |

**G 订阅代际（F4）**

| #   | 场景                           | 判据                                              |
| --- | ------------------------------ | ------------------------------------------------- |
| G1  | 同一个 run 快速 subscribe 两次 | 只投递第二次的 history；watch 只发一次            |
| G2  | pending 期间 unsubscribe       | 迟到的 reply 被丢弃；只 unwatch 一次              |
| G3  | pending 期间 SSE 关闭          | 同 G2，不出现异常                                 |
| G4  | pending 期间 agent_down        | 收到 `E_AGENT_GONE` 错误帧                        |
| G5  | 两个 client 订阅同一个 run     | 一个 watch；各自有自己的快照；`run_ev` 扇出给两个 |
| G6  | A 退订                         | B 不受影响；最后一个退订时才发 off                |
| G7  | 第 3 个不同的 run              | 503；UI 自愈后成功                                |
| G8  | pending 期间收到 `run_end`     | history 之后按序投递 end                          |
| G9  | pending 缓冲溢出               | 先投 history，再发起一次 resync                   |

**L 门控三层组合（F2/F3b/F4）**

| #     | agent 设置                                  | agent cap                   | listener | 判据                                            |
| ----- | ------------------------------------------- | --------------------------- | -------- | ----------------------------------------------- |
| L1/L2 | `all`                                       | `runtx.v1` + `runtx.lan.v1` | lo / lan | 都可用                                          |
| L3/L4 | `loopback`                                  | `runtx.v1`                  | lo / lan | lo 可用；lan ⇒ 409 `unsupported`                |
| L5/L6 | `off`                                       | 无                          | lo / lan | 都是 409                                        |
| L7/L8 | 旧 agent                                    | 无                          | lo / lan | 都是 409；UI 不显示入口                         |
| L9    | 运行中把 `all` 改成 `loopback` 并 `/reload` | caps 变化                   | lan      | 已有的 LAN 订阅收到 `unsupported` 并被清理      |
| L10   | `loopback`                                  | `runtx.v1`                  | lan      | 绕过 UI 直接调 subscribe 和 GET page ⇒ 都是 409 |

**P 性能（F3a，perf 测试用宽松阈值，只防退化；真机再测一遍）**

| #   | 场景                             | 判据                                            |
| --- | -------------------------------- | ----------------------------------------------- |
| P1  | 47MB 合成文件，取尾部 200 条快照 | 耗时 < 500ms；扫描期间 `/healthz` 的 p99 < 50ms |
| P2  | 两个 tab 同时打开同一个 run      | 只扫描一次（single-flight 计数）                |
| P3  | 3 个不同的大文件同时请求         | 2 个并行、1 个排队；超过 deadline ⇒ `busy`      |
| P4  | 17 个不同的游标                  | 触发 LRU 淘汰，重新扫描后结果仍正确             |
| P5  | 翻页续扫                         | 累计扫描字节数没有回到 0（复用了游标）          |

**U UI（F6/F5；happy-dom + `@vue/test-utils`，事件用 `dispatchEvent(new KeyboardEvent(...,{bubbles:true}))` 派发）**

| #   | 场景                                                                                                                           | 判据                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| U1  | 三种模式（mock `matchMedia`）                                                                                                  | `data-drawer` 正确；只有 docked 模式写 localStorage                                                                            |
| U2  | overlay 模式下，焦点在已武装的 Stop 按钮上按 Esc                                                                               | 解除武装，抽屉不关闭；再按一次 Esc ⇒ 抽屉关闭；`DashboardView` 不会执行 back                                                   |
| U3  | `isComposing` 为真 / 焦点在 input 里按 Esc                                                                                     | 不关闭                                                                                                                         |
| U4  | pointerdown 落在外部 / 内部 / toggle 按钮                                                                                      | 分别是关闭 / 不关闭 / 不关闭（不会关了又重开）                                                                                 |
| U5  | 焦点                                                                                                                           | 打开时到关闭按钮；关闭后回到 toggle 按钮；toggle 不存在时回到 `#transcript`                                                    |
| U6  | 切换 agent                                                                                                                     | transport 调用顺序为 `runUnsubscribe` 在 `unsubscribe` 之前；卸载后 document 上没有残留监听（`removeEventListener` 被 spy 到） |
| U7  | **两个 Transcript 并存**（#16）                                                                                                | 主区与抽屉的 following、newCount、分页（`load-older` 分别发到 `page` 和 `pageRun`）、窗口 start 各自独立；DOM 中没有重复 id    |
| U8  | 三级嵌套，且父节点没有列出                                                                                                     | 子节点作为根显示，并带「父 run 未列出」chip                                                                                    |
| U9  | 70 个 active（6 个被省略）、12 个 terminal（4 个被省略）                                                                       | 省略行显示 6 和 4                                                                                                              |
| U10 | 被选中的 run 移出 rows                                                                                                         | 头部使用 `lastRow`，显示「不在列表中」标记，transcript 不中断                                                                  |
| U11 | `watching:false`                                                                                                               | 页脚显示 `streamLine \|\| toolTrail`，与 `FleetNode` 显示一致                                                                  |
| U12 | 401 矩阵：token 模式下 runSubscribe/runPage 走 relogin 重放、runUnsubscribe 吞掉失败；password 模式三者都触发 `onConn("auth")` | 两种 transport 的 contract 测试都通过                                                                                          |
| U13 | 订阅 watchdog                                                                                                                  | 10 秒后重订；累计 2 次后进入 error 态，显示重试按钮                                                                            |

---

## 11. 不做 / 后续

- run 深链（`#/agent/<key>/run/<runId>`），需要改 `useHashRoute.ts`，作为单独的小包。
- 抽屉宽度拖拽调整。
- 子 run transcript 内搜索。
- 已从 agent registry 驱逐的历史 run：返回 `unknown_run`。以后要做可以接入 consult 的 expert-index（`consult/expert-index.ts`）。
- 对 `rememberAgents:false` 的 run 在内存中保留 final snapshot：不做，理由见 §3.6。
