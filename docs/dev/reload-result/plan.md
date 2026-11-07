# #30 Web reload 命令回传真实结果 · 实施方案（r3）

> 输入：`docs/dev/reload-quit/explore.md` §5、`docs/dev/web-update-stuck/{plan,PA-report,PB-report,PC-report}.md`（#23）、`docs/dev/web-hub/README.md`、`docs/dev/deferred-reload/README.md`、AGENTS.md（I1/I2/I4/I5/I7/I9/I10、Frozen）。车道 L2：P-A ∥ P-U 同树并行，P-C 在两包合入后。r1→r2 处理 GPT 评审（1B/6M/2m），见文末处置表；本轮未能读取 run 原文，以评审要点为准。

## 现状事实（影响取舍）

1. **订正 explore §5.2-2**：按钮发的是扩展命令 `agent reload`（`src/web-hub/ui/src/composables/useOutdatedReload.ts:153`），走 `dispatchExtension`（`src/web-hub/agent/builtin-bridge.ts:235-326`，入口 `:683-684`），不是 builtin `/reload`（`:607-620`）。实际应答分三种：fleet 忙时为 `sync` 并带英文 output；空闲时为 `async`，随后 shutdown 里 `commandCapture.dispose()`（`src/web-hub/agent/index.ts:1889`）补一个 `cmd_late{sync}`；流式时与「已启动」在应答上无法区分。协调器只读 `outcome.ok`（`src/web-hub/ui/src/logic/outdatedReload.ts:390-400`）。
2. **TUI 宿主吞掉失败**：`ctx.reload` 映射到 `handleReloadCommand`（pi `modes/interactive/interactive-mode.js:1528-1530`）。流式或压缩中只提示，然后正常返回（`:5328-5336`）；加载失败由它自己 catch 成 `Reload failed:`，然后正常返回（`:5397-5402`）。所以 `command-port.ts:137-142` 的 catch 在 TUI 下基本不会触发。RPC 的 `ctx.reload` 直接调 `session.reload()`，异常会抛给调用方（`modes/rpc/rpc-mode.js:252-253`）。
3. `AgentSession.reload()` 先 emit `session_shutdown{reload}`，再 `invalidate`，再重新加载，最后才 emit `session_start{reload}`（`core/agent-session.js:2998-3031`）。shutdown 之后若加载失败，就没有新 activation；旧连接 10s 后以 `detach-timeout` 下线（`agent/connection.ts:398-412`）。
4. 处于 `agent_settled` 发射期间时，`prompt()` 会把命令推迟执行（`core/agent-session.js:1632-1634`），因此「bridge 返回」与「handler 执行」之间不存在同步关系。capture 代理在构造时持有 cmdId（`src/commands/capture.ts:493-520`，`createCapturedCtx(ctx, capture, cmdId, …)`），推迟的调用经回退队列匹配后仍拿到该代理（`:779`）。
5. 结局分布在 `src/reload/`：`command-port.ts:55-142`（arm/cancel/deferFire/reload）、`defer.ts:110-142`（等闲失败的 notify）、`commands/status.ts:225-282`（路由，不可用分支在 `:245-246`）。只有新 activation 的 session_start 能看到接管（参考 `reload/continue.ts:27-58` 的 reason + 身份 + TTL 读后即删）。
6. StatusInfo 是开放槽（`protocol/messages.ts:685-777`）。hub 原样存储和转发（`hub/registry.ts:527-533`、`hub/http.ts:694-696`），并有 #88 订阅补发；UI 原样存放（`ui/src/logic/state.js:738-742`）。`setSlot()` 在 live 时**立即** `writeRaw`；`flush` 只是同步变换，不做合并（`agent/connection.ts:453-475`）。A 级 golden 钉住默认 hello 和 status 键（`tests/fixtures/schedule-off-golden.json`）。
7. 命令应答通道放不下迟到的结局：`cmd_late` 不回放，hub LRU 只升级 `unknown`（`hub/commands.ts:381-399`），ledger 每个 id 只结算一次（`agent/commands.ts:1121-1135`），capture 窗口为 30s（`commands/capture.ts:69`）。
8. 前端：`enterAwaiting` 每次调用都会重开 90s（`outdatedReload.ts:358-364`）；parked 到达总截止时先 `sendCancel` 再报 `E_QUEUE_TIMEOUT`（`:329-340`）；`fail()` 会删除截止记录（`:300-305`）。`runCommand` 支持自带 id（`ui/src/types.ts:417`）。`tests/tiers.ts:196` 把 `epoch-up-compat` 登记为 TIER1_DECLARED（kind proc）。

## 0 需求摘要与已定事项

Web 发起的 outdated reload，由 agent 回传它**能确认的**结局：已延后（等 run 或等本轮结束）、已启动、已取消（带原因）、失败（带原因）、已完成（身份已验证的新模块接管，带版本）。#23 状态机据此更早、更准地结算。宿主吞掉的失败如实降级为「失联或未知」。老 agent 的行为与 #23 完全一致。不做：改 deferred reload 的语义、新帧、新 cap、PROTO bump、hub 源码改动。

用户已拍板（2026-11-05）：

- **Q1**：TUI 发起的 reload 不主动上报。但 TUI 对**已跟踪的** Web 请求执行的 cancel/now 属于该请求生命周期内的事实，必须正确归属。
- **Q2**：已完成但版本不等于 hub ⇒ 立即报 `E_RELOAD_NO_UPGRADE`。前提是接管身份已验证、版本可信且非缺失。版本未知时既不判成功，也不断言没升级。
- **Q3**：收到 `E_RELOAD_IDLE_WAIT` 后，前端立即判失败，不额外 cancel；但 #23 绝对截止的取消规则照常执行。
- **Q4**：已失败的条目不能被迟到的中间态恢复为等待中。只允许同一请求迟到的 completed 转为成功，以及有限的原因细化。

## 1 设计决定

**D1 生命周期与归属（修 M2）**。归属单位是 **reload 生命周期 `life`**，不是记录槽：

- `life` 由 command-port 用 `randomUUID()` 生成。一个 life 从第一个事实（handler 入口、arm、直接 reload）开始，到 cancel、unavailable、`ctx.reload` 返回或 activation 结束为止。**life 下面是执行级 token `execId`**：每次真正「调用 reload」都分配一个新的 `execId`（不依赖「controller 最多一个 pending」的推导——`reload now` 的 5s await 可能和另一次 now、或和一次 reload 调用重叠，且真调用前还会 disarm，见 `src/commands/status.ts:249-281`、`src/reload/command-port.ts:88-141`）。
- **合并进来的请求只订阅 life 的结果，不触发重复执行**；后到的 now 或 reload 调用各自拿到新的 `execId`，成为「当前执行」，旧的执行降级为过时。
- **所有异步回调（started/failed/cancelled/接管）都按 `execId` 校验**：只接受等于「当前执行」的事实，旧执行的回调一律丢弃，不能覆盖新执行的事实。
- **不加执行单飞门**：同一时刻允许存在多个重叠的执行，deferred reload 的既有语义（arm 幂等、now 强制、fire 重数）完全不变；本方案只在采集侧丢弃过时执行的事实，这是有意取舍——加单飞门会改变 deferred reload 的行为，超出本任务范围。
- 每个事件携带 `{life, execId, by?}`。`by` 是 capture 代理新增的只读属性 `webCmdId`，由 `commands/capture.ts` 导出 `webCmdIdOf(ctx)`，值来自事实 4 的 cmdId。TUI 调用没有这个属性。
- 异步回调（5s settle、idle 回调、`await ctx.reload()` 之后）在入口处捕获 life 对象**和本次 `execId`**，并以两者发射。tracker 先比 `life`、再比 `execId`（`execId === 当前记录.execId`），任一不符即丢弃。失败回滚同理。
- **重复 Web 请求一律合并**：B 的 handler 执行时若 A 的 life 仍挂起，B 的 cmdId 并入同一 life，`cmdIds` 最多 4 个，FIFO。这与后端「arm 幂等、只 reload 一次」的事实一致。life 已关闭后到来的请求开新 life，并取代旧记录。
- **Q1 落地**：事件 `by` 有值 ⇒ 建立或并入记录。事件 `by` 为空（来自 TUI），且其 life 已有记录 ⇒ 照常记入（TUI 对 Web 请求执行的 cancel 或 now）；life 没有记录 ⇒ 忽略。推迟执行（agent_settled）超出 capture 回退 TTL 而拿不到 `webCmdId` 的请求不被跟踪，前端退回推断。

**D2 状态集合与 wire**（`protocol/messages.ts`：StatusInfo 新增 `reload?: ReloadStatusWire`）：

```ts
export interface ReloadStatusWire {
  v: 1;
  life: string; // reload 生命周期 id
  cmdIds: string[]; // 归属该 life 的 web 命令帧 id，1..4
  rev: number; // life 内单调递增，每个新事实 +1（UI 据此去重）
  execId: string; // 当前执行的 token：写入方只在「当前执行」的事实上带它
  state: "deferred" | "started" | "cancelled" | "failed" | "completed";
  open: boolean; // 采集侧判断：该请求是否仍在进行（例如 IDLE_WAIT 之后仍挂起则为 true）
  at: number; // agent 时钟；UI 不用它判过期
  waitingFor?: "runs" | "idle";
  activeRuns?: number; // deferred 专用
  code?: ReloadCode; // failed/cancelled 专用，取值见 D3
  message?: string; // 仅 E_RELOAD_THREW 带，≤256 B，按 UTF-8 边界截断
  version?: string; // 仅 completed 带，且只在可信时出现
  epoch?: string; // 仅 completed 带：接管方 MODULE_INSTANCE
}
```

两种「终态」要分开看（修 M3）：`state` 是**最近一个事实**，`open` 表示**整个请求是否已结束**。`failed E_RELOAD_IDLE_WAIT` 发出时 `open:true`，后端继续记录随后发生的 started、completed 或 cancelled（failed→started→completed，failed→cancelled）。对 UI 来说，failed 是终态（Q3/Q4）；对采集侧来说，只有 `open:false` 才算结束。

**D3 采集点与能力边界（修 M5）**：

| 事实                                               | 采集点                                                                 | wire                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| arm 或刷新                                         | `port.arm` 每次 `ctl.arm` 之后                                         | `deferred{runs\|idle, activeRuns}`                          |
| 登记等闲                                           | `port.deferFire` 返回 true                                             | `deferred{idle}`                                            |
| 等闲 30 分钟超时或失败                             | `deferFire` 传入的 notify 回调                                         | `failed E_RELOAD_IDLE_WAIT, open:true`                      |
| 任意来源的 cancel                                  | `port.cancel`，wasPending 时                                           | `cancelled user, open:false`                                |
| 宿主不能 reload                                    | 新增 `port.unavailable(ctx)`（`status.ts:246` 改调它）/`reload()` 入口 | `failed E_RELOAD_UNAVAILABLE, open:false`                   |
| now 5s 内没等到 settle                             | `reload()`                                                             | `failed E_RELOAD_SETTLE, open:ctl.pending`                  |
| 即将调用 `ctx.reload`                              | `reload()` 中紧挨 `:138` 之前                                          | `started`，同时写接管标记（D4）                             |
| `ctx.reload` 返回，但本 activation 没看到 shutdown | `reload()` 发 `returned` 事件，由 tracker 判定                         | `failed E_RELOAD_REFUSED, open:false`（TUI 流式或压缩拒绝） |
| `ctx.reload` 抛错，且仍 attached                   | catch                                                                  | `failed E_RELOAD_THREW` 加 message（主要是 RPC）            |
| shutdown(reload) 之后加载失败（TUI 自行吞掉）      | **无法采集**                                                           | 不发帧；UI 根据 started 加下线判 `E_RELOAD_LOST`            |
| 记录不在 started 时发生 shutdown(reload)           | web-hub shutdown                                                       | `cancelled superseded, open:false`（被别的 reload 取代）    |
| 非 reload 原因的 shutdown，且记录为 open           | web-hub shutdown                                                       | `cancelled session\|quit, open:false`                       |
| 接管验证通过                                       | 新 activation 的 session_start                                         | `completed{version?, epoch}, open:false`                    |

不承诺所有失败都有具体原因：TUI 真实的加载失败只能体现为「已启动、未接管」。

**D4 接管标记（修 Blocker）**。只有**实际发射了 `started`** 的 life 才会写接管标记，`requested`/`deferred` 永远不会直接变成 completed：

- 标记结构：`{life, cmdIds, sessionId, sessionFile, originEpoch: MODULE_INSTANCE, startedAt, shutdownAt?}`。
- 旧 activation 的 shutdown(reload) 只写入 `shutdownAt`。投影没有变化，所以不发帧。
- 新 activation 的 session_start 读完标记即删除，然后**全部**满足下列条件才记 completed：`reason==="reload"`；sessionId 与 sessionFile 都与当前一致；`originEpoch !== MODULE_INSTANCE`；`shutdownAt` 已写入；`0 ≤ now−startedAt ≤ 120_000`；记录的 life 等于标记的 life。
- 版本取 `packageVersionSync()`。值为空或 `"0.0.0"` 时不写 `version`，表示版本未知。
- 任何一条不满足 ⇒ 不写 completed，记录保持 started；UI 走生效计时或版本推断。completed 缺 `epoch` 或缺 `version` 时，UI 一律按未知处理。

**D5 进程级结构（修 m8）**：

- 存放位置：`Symbol.for("pi-subagent:web-hub:reload-track")`，内容为纯数据 `{v:1, rec?: Rec, handover?: Marker}`，**容量 1 条记录加 1 个标记**。
- 读到未知 `v` 或损坏的结构 ⇒ 视为空，下次写入时整体覆盖（降级、升级、清除都按这条规则）。老模块不认识这个键，只会忽略。
- **读取的时间规则**：记录的时间戳在未来，或 `now - at < 0`（时钟回拨）⇒ 一律视为**无效**：按空处理并立即清除，不参与投影、不做接管验证。
- TTL 只约束读取：`open:false` 的记录投影 10 分钟；`open:true` 的记录 40 分钟内没有新事实就过期（大于 #23 的 30 分钟总预算）；标记 120s 过期。
- 过期由现有 1s `onTick`（`agent/index.ts:1105`）比较投影指纹：变了才 `publishStatus` 一次，不新增计时器。
- UI 不按 `at` 判过期，只按 cmdId 和 rev 判断，因为两端时钟不同源。

**D6 通道与发送纪律（修 M6）**：

- 通道仍是 StatusInfo 开放槽，不加新帧或 cap。备选方案为何不选见事实 7，以及「新帧 + cap 需要 hub 解析、SSE、回放和协商」。
- tracker 的 `apply(event)` 返回投影是否变化。**变化且 attached 时才 `publishStatus`**；没有记录或投影未变时不产生任何输出（不 publish，也不加字段）。
- `publishStatus` 只在投影存在时追加 `s.reload`。off 场景、TUI 场景和无跟踪场景的完整帧序列逐字节不变。
- 跟踪中的 Web 场景只允许两类差异：① 已有的 status 帧多一个 `reload` 字段；② 每个**投影变化**额外发一帧 status。
- WebHubControl 新增 `onReloadPhase`；`src/index.ts:846` 用晚绑定 `() => webHubRef.current?.onReloadPhase` 装配。不新增 `pi.on`，所以 handlerCounts 不变。

**D7 hub**：零源码改动，不持久化。hub 重启后 agent 重连会重放槽，进程级记录在 TTL 内会再次投影出来。

**D8 前端吸收**（`outdatedReload.ts`，修 M4/M7）：

- 每次 send 用 `deps.newCmdId()` 生成 id，记入 `cmdIds`，再调 `deps.send(key, cmdId)`。
- `deps.reloadOutcome(key)` 由 composable 调纯函数 `parseReloadStatus(status)` 防御性收窄：`v===1` 且字段类型齐全才返回，否则为 undefined。
- **匹配**：`o.cmdIds.includes(本 attempt 的 cmdId)`。**去重**：`o.rev > appliedRev(key)` 才处理，同一 rev 只处理一次。

notifyTick 和 `send().then(ok)` 共用同一个 `absorb()`，优先级如下：

1. `isSettled`（版本到位）⇒ done。
2. 匹配到终态事实：`completed` 且带 `version` 和 `epoch` ⇒ 版本等于 hub 判 done，不等判 `E_RELOAD_NO_UPGRADE`；`completed` 缺 `version` ⇒ 不判定（按未知处理，等版本到位或生效计时）；`failed` ⇒ 用它的 code（加 message）；`cancelled` ⇒ `E_RELOAD_CANCELLED`，不发 cancel。
3. 下线：最近一次已吸收的事实是 started ⇒ `E_RELOAD_LOST`；否则 ⇒ `E_OFFLINE`。
4. 匹配到中间态（只在 sending/awaiting/parked 三相）：`deferred` ⇒ parked，带上 waitingFor，**此后不再按 fleet 回 awaiting**；`started` ⇒ awaiting，**同一 cmdId 只建立一次** `effectDeadlineAt = min(now+90s, deadlineAt)`，之后的重复补发或 tick 都不重开；sending 相收到任何匹配事实都清掉 send 计时。
5. 无匹配 ⇒ 沿用 #23 原逻辑（fleet 启发式，parked→awaiting 时重开 90s）。

failed 相的规则（Q4）：只接受 completed（满足第 2 条）⇒ done；只允许把 `E_OFFLINE|E_SEND_UNKNOWN|E_TIMEOUT` 细化为 `E_RELOAD_*` 或 cancelled；已有的 `E_RELOAD_*` 不再细化；`E_QUEUE_TIMEOUT` 只有唯一例外——见下段「Q3 与绝对截止的竞态」里的确定性规则（总截止与 IDLE_WAIT 同到 ⇒ 细化成 `E_RELOAD_IDLE_WAIT`）。迟到的 deferred/started 一律忽略。

**Q3 与绝对截止的竞态**。前端预算从 request 起算，后端 30 分钟从 waitForIdle 起算，所以正常情况下前端截止先到：parked ⇒ `sendCancel` 加 `E_QUEUE_TIMEOUT`，与 #23 相同。若后端先报 IDLE_WAIT（例如后台标签页的计时器被延迟），则立即 `fail(E_RELOAD_IDLE_WAIT)`，不 cancel；同时另存 `cancelAt = deadlineAt`（新 map，不受 `fail()` 删除截止记录的影响）。**确定性规则（同一 tick 内 IDLE_WAIT 与总截止竞争）：不论处理顺序，总截止都已到 ⇒ 恰好发一次 `sendCancel`，最终原因统一为 `E_RELOAD_IDLE_WAIT`**——Q4 允许的「失败原因的有限细化」，`E_QUEUE_TIMEOUT → E_RELOAD_IDLE_WAIT` 正属于这一种。`absorb()`、总截止回调与 `cancelAt` 三者共用这一条规则（幂等：cancel 用 `cancelled` 标记去重，原因取更具体的那个）。到点时，若期间没有匹配到 `open:false` 的事实，就 `sendCancel` 一次，条目保持 failed；retry 或 reset 会清掉 `cancelAt`。我方 cancel 之后迟到的 `cancelled user` 不再细化原因。文案区分两种超时：`errQueueTimeout` 是「网页端 30 分钟总时限已到，已取消排队」；`errReloadIdleWait` 是「会话侧等待空闲超时，reload 仍挂起；到总时限会自动取消」。

**D9 老 agent 与结果丢失**：

- 没有 `status.reload` ⇒ 走第 5 条，与 #23 行为一致。老 hub × 新 agent：开放槽原样转发。旧 UI：忽略未知字段。
- 记录只存在进程内存里。进程退出、shutdown 之后加载失败、链路未处于 live（`setSlot` 只保存最后一帧，中间态可能丢失，但状态是电平式的）、写出失败或背压——这些情况都退回推断：下线报 `E_OFFLINE` 或 `E_RELOAD_LOST`；版本到位仍收敛为 done。
- 新进程接手时 agentKey 和记录都会变，不跨 key 追认。

## 2 改动清单（仓库精确路径；派发前用 `node skills/dev-flow/scripts/conflict-check.mjs` 预检）

**P-A：agent 与协议（dev）**。源码：`src/reload/phase.ts`（新建）；`src/reload/command-port.ts`（`:40-145`）；`src/commands/status.ts`（`:245-246`）；`src/commands/capture.ts`（`createCapturedCtx` 在 `:493-520` 加 `webCmdId` 属性，导出 `webCmdIdOf`）；`src/index.ts`（`:846`）；`src/web-hub/protocol/messages.ts`（新增 `ReloadStatusWire`，并在 `:777` 之前加 `reload?`）；`src/web-hub/agent/reload-track.ts`（新建）；`src/web-hub/agent/index.ts`（`:477` WebHubControl、`:1007-1056` publishStatus、`:1105` onTick、`:1808` session_start、`:1862-1907` session_shutdown）。文档：`docs/dev/deferred-reload/README.md`（I7/I9/I10 改为 phase observer）。测试：`tests/reload/{command-port,status-reload,fire-idle}.test.ts`、`tests/web-hub/agent/{reload-track,wiring-reload-status,reload-result-compat}.test.ts`（新建）、`tests/web-hub/agent/capture-commands.test.ts`、`tests/commands/capture.test.ts`、`tests/fixtures/web-hub/reload-result-compat-golden.json`（新建，本包唯一允许新增的 fixture）。本包测试只用 fakeNet，**不监听 socket**，因此不改 `tests/tiers.ts`。

**P-U：前端（frontend-dev）**。源码：`src/web-hub/ui/src/logic/outdatedReload.ts`（`:200-260` deps，`:300-372` fail/effect/cancelAt，`:374-410` send，`:461-492` notifyTick，`:560-585` orFailReason，新增 `parseReloadStatus`）；`src/web-hub/ui/src/composables/useOutdatedReload.ts`（`:135-200`：newCmdId、透传 `{confirm,id}`、reloadOutcome、watch 签名追加 `:${life}/${rev}`）；`src/web-hub/ui/src/i18n/zh/outdated.ts` 与 `src/web-hub/ui/src/i18n/en/outdated.ts`（新增 `errReloadLost/NoUpgrade/Cancelled/Unavailable/Settle/IdleWait/Refused/Failed`、`parkedIdle`，改写 `errQueueTimeout`）；`src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue`。测试：`tests/web-hub/ui/{outdated-reload,outdated-reload-surfaces}.test.ts`、`tests/web-hub/ui/outdated-reload-result.test.ts`（新建）。

**P-C：闭环与文档（dev，等 P-A、P-U 合入后）**。`tests/web-hub/hub/reload-status-passthrough.test.ts`（新建）；`tests/integration/web-hub-reload-result-loop.test.ts`（新建，在 integration 目录下自动归 tier2）；`tests/tiers.ts`（**只归本包**，按 `:196` 的先例把 passthrough 登记为 TIER1_DECLARED proc）；`docs/dev/web-hub/README.md`（等另一个包的下线原因表合入后再改）。

**冻结面**：`tests/fixtures/**` 中已有的文件（A 级一律不得重生）；`src/web-hub/hub/**`；`src/web-hub/protocol/**` 中除上述新增类型以外的部分；`src/web-hub/agent/{builtin-bridge,commands,connection}.ts`；`src/reload/{defer,continue,index}.ts`；`src/web-hub/ui/src/logic/{state,control,token-client,password-client}.js`；`src/web-hub/ui/src/composables/useHub.ts`；`tests/integration/web-hub-outdated-reload-loop.test.ts`（只读，复跑）。

## 3 验收矩阵（每行至少一条用例）

| #   | 场景                                                                                                                                                                                                                                    | 期望                                                                                                                                                                   | 层与文件               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| G1  | **第 0 步，先于任何 src 改动**：在未修改实现上录制 s1（TUI `/agent reload`，空闲，含 handover）、s2（Web `agent reload`，空闲）、s3（Web，fleet 忙，之后 cancel），用 `PI_TOOLKIT_RELOAD_RESULT_GOLDEN_CAPTURE=1`，文件已存在时拒绝覆盖 | s1 的**完整帧序列**逐字节相等；s2、s3 的 hello、cmd_result、cmd_late 及其他槽逐字节相等；status 只出现 D6 允许的两类差异，用例逐帧列出允许清单，剔除后与原序列完全相等 | P-A compat             |
| G2  | 默认配置，以及 webHub 关闭                                                                                                                                                                                                              | 五份 A 级 golden 复跑通过；没有 `reload` 字段，没有额外帧                                                                                                              | P-A                    |
| G3  | 没有记录时 observer 收到事件，或投影未变化                                                                                                                                                                                              | 没有 publish，帧计数不变                                                                                                                                               | P-A wiring             |
| A1  | A 执行 now（5s settle 等待中），B 也执行 now                                                                                                                                                                                            | A、B 各自拿到新 `execId`，B 成为当前执行；A 的 settle 回调按 execId 丢弃；cmdIds 合并进同一 life，只执行一次 reload                                                    | P-A command-port/track |
| A2  | 旧执行的失败或取消回调晚于另一执行的 started                                                                                                                                                                                            | 旧 execId 的回调丢弃，不覆盖新执行已写的 started；记录仍是新执行的事实                                                                                                 | P-A                    |
| A3  | agent_settled 推迟执行，handler 晚于 bridge 返回                                                                                                                                                                                        | 仍按代理的 webCmdId 归属；超出 capture TTL 时不跟踪                                                                                                                    | P-A                    |
| A4  | Web 请求被 deferred，期间 TUI 执行 `/agent reload now`，然后接管                                                                                                                                                                        | 依次记 started、completed，归属 Web 的 cmdId（Q1）                                                                                                                     | P-A + P-C              |
| A5  | 收到 IDLE_WAIT（`open:true`）之后，分别 TUI now、TUI 重试、TUI cancel                                                                                                                                                                   | failed→started→completed；failed→cancelled；记录都不被忽略                                                                                                             | P-A + P-C              |
| A6  | Web 请求处于 requested 或 deferred 时，别的来源（内置 `/reload`）完成了 reload                                                                                                                                                          | `cancelled superseded`，**不是** completed；UI 由版本推断判 done                                                                                                       | P-A + P-C              |
| A7  | 接管标记的身份不符：sessionId 或 file 不同、超过 120s、同一 epoch、缺 shutdownAt、v 未知或结构损坏                                                                                                                                      | 不记 completed；损坏结构按空处理                                                                                                                                       | P-A track              |
| A8  | TUI 宿主流式中直接返回                                                                                                                                                                                                                  | `failed E_RELOAD_REFUSED`                                                                                                                                              | P-A                    |
| A9  | TUI 在 shutdown 之后加载失败（提示后 resolve，且没有新 activation）                                                                                                                                                                     | 没有新的结局帧；UI 判 `E_RELOAD_LOST`                                                                                                                                  | P-A + P-C              |
| A10 | RPC 宿主在 shutdown 之前抛错                                                                                                                                                                                                            | `failed E_RELOAD_THREW`，message 已截断                                                                                                                                | P-A                    |
| A11 | completed 时 `packageVersionSync` 返回 `"0.0.0"`                                                                                                                                                                                        | 不写 version；UI 不判 done，也不判 NO_UPGRADE                                                                                                                          | P-A + P-U              |
| A12 | TTL 到期，onTick 触发                                                                                                                                                                                                                   | 只发布一次撤销后的 status；之后不再发                                                                                                                                  | P-A                    |
| A13 | A 的 now 正在等待时 cancel，随后发起新请求                                                                                                                                                                                              | 旧执行按 execId 失效；新请求开新 life（旧 life 关闭后）或并入；记录不出现旧执行残留                                                                                    | P-A                    |
| U1  | 同一个 started（rev 相同）补发多次，叠加每秒一次的 notifyTick                                                                                                                                                                           | effectDeadline 只建立一次，到点 `E_TIMEOUT`                                                                                                                            | P-U                    |
| U2  | 跨 attempt：attempt1 的 cancelled 迟到；TUI 来源（cmdIds 不含本 attempt）                                                                                                                                                               | 被忽略                                                                                                                                                                 | P-U                    |
| U3  | SSE 先于 HTTP 到达；sending 期间收到 deferred                                                                                                                                                                                           | 进 parked，清掉 send 计时器                                                                                                                                            | P-U                    |
| U4  | deferred(idle) 持续 30 分钟                                                                                                                                                                                                             | 不出现 90s 误判；到截止时先 cancel，再报 `E_QUEUE_TIMEOUT`                                                                                                             | P-U                    |
| U5  | 同一 tick 内 IDLE_WAIT 与总截止竞争，两种处理顺序；我方 cancel 之后迟到的 cancelled                                                                                                                                                     | 两种顺序下 `sendCancel` 都**恰好一次**，最终原因都统一为 `E_RELOAD_IDLE_WAIT`；迟到的 `cancelled user` 不再细化原因                                                    | P-U                    |
| U6  | started 后下线，随后同 key 收到 completed                                                                                                                                                                                               | 先 `E_RELOAD_LOST`，再 done                                                                                                                                            | P-U + P-C              |
| U7  | completed 且版本不等于 hub；completed 缺 epoch                                                                                                                                                                                          | `E_RELOAD_NO_UPGRADE`；按未知处理                                                                                                                                      | P-U                    |
| U8  | failed 相收到迟到的 deferred/started；`E_OFFLINE` 后收到 failed                                                                                                                                                                         | 不复活；原因细化                                                                                                                                                       | P-U                    |
| U9  | 没有 `status.reload`                                                                                                                                                                                                                    | #23 全部现有用例**断言不改**，照样通过                                                                                                                                 | P-U                    |
| U11 | 记录读取时遇到未知 `v`、损坏结构、未来时间戳、`now - at < 0`                                                                                                                                                                            | 全部按空处理并清除，不投影、不参与接管验证                                                                                                                             | P-A track              |
| U10 | v≠1 或结构损坏的 status.reload；用未修改的 `state.js` 的 reduce 处理                                                                                                                                                                    | parse 结果为 undefined；reduce 保留未知字段                                                                                                                            | P-U                    |
| C1  | 真实 agent-server（socket）→ registry → HTTP/SSE，加上 #88 订阅补发                                                                                                                                                                     | `reload` 原样通过；空闲时过期撤销后重新订阅，看不到残影                                                                                                                | P-C passthrough        |
| C2  | 闭环正例：deferred→parked→started→第二个 activation 接管（epoch 变化、走 reclaim）→completed→done，早于 90s；对照组为去掉字段的老 agent                                                                                                 | 正例按期望结算；对照组与 `web-hub-outdated-reload-loop` 结果一致                                                                                                       | P-C loop               |

## 4 门禁命令

- **P-A**：`npx vitest run tests/reload tests/commands tests/web-hub/agent tests/web-hub/protocol tests/web-hub/boundary.test.ts tests/boundary/pi-free.test.ts tests/governance`；A 级：`npx vitest run tests/integration/{thread-off,thread-rebind-off,fabric-xs-off,fabric-xs-reply-off,schedule-off}-golden.test.ts tests/reload/activation.test.ts tests/web-hub/hub/epoch-up-compat.test.ts`；`npm run typecheck`；`git diff --stat origin/dev -- tests/fixtures/` 只允许出现那一份新 golden。
- **P-U**：`npx vitest run tests/web-hub/ui`、`npm run typecheck`、`npm run build:web`、`npm run check:web`、`npx prettier --check <改动文件>`
- **P-C**：`npx vitest run tests/web-hub/hub tests/governance/test-tiers.test.ts tests/integration/web-hub-reload-result-loop.test.ts tests/integration/web-hub-outdated-reload-loop.test.ts`
- **合流**（root 执行，只跑一份；并行 agent 一律不跑全量）：`npm run format:check` → `typecheck` → `npm run test:tier1`（日常门禁）→ `npm run test:tier2` → `build` → `build:web` → `check:web` → 检查 fixtures diff

## 5 风险

- **断链与背压**：`started` 写出时链路可能不在 live 状态，或 `writeRaw` 失败，中间态因此丢失。后果仅限于退回推断；completed 由新 activation 在 hello 之后重放槽时送达。P-A 需要实测 shutdown 前这一帧能否落到 wire。
- **TUI 吞错**：失败只能报为「已启动、未接管」，没有具体原因，这是宿主能力的边界。P-A 需要核对 RPC 与 TUI 的真实差异，写进报告。
- 取代旧记录只发生在旧 life 已关闭之后；同时挂起的请求会合并，cmdIds 超过 4 个时，最早的那个退回推断。
- `packageVersionSync` 读的是磁盘上的版本，安装进行到一半时可能与已加载的代码不一致；最坏情况是误报 NO_UPGRADE，版本帧到位后仍会收敛为 done。
- 改 `capture.ts` 会触及命令捕获的公共代理：新属性只读，默认不可枚举，由 `capture-commands`、`capture.test.ts` 回归。

## 6 开放问题

无。Q1–Q4 已拍板（§0）；重复请求合并是由后端 arm 幂等推导出的结论，不需要拍板。

## 评审处置表（GPT 第 1 轮）

| #    | 级别       | 问题                                                                   | 处置                                                                                                                                                                                             | 位置                           |
| ---- | ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1    | Blocker    | reason=reload 时非终态被误判为 completed                               | 接受：接管标记只能由 started 建立，按 life、cmdIds、session 身份、originEpoch≠当前、shutdownAt、120s 窗口逐项验证；requested/deferred 遇到 reload 改记 superseded；缺证明的 completed 按未知处理 | D3、D4、D8-2、A6/A7/A11        |
| 2    | Major      | phase 无命令身份，容量 1 导致串号                                      | 接受：引入 life，以 capture 代理的 webCmdId 作为 `by`；异步回调和回滚按 life 身份校验；重复请求合并（≤4）；去掉 bridge 的 begin，改用代理归属，覆盖推迟执行                                      | D1、A1–A3                      |
| 3    | Major      | 「终态即忽略」与迟到 completed 冲突                                    | 接受：拆分 `state`（最近事实）与 `open`（请求是否结束）；IDLE_WAIT 之后仍记录后续事实；明确 failed→started→completed 与 failed→cancelled                                                         | D2、D3、A4/A5                  |
| 4    | Major      | 重复的 started 反复重开 90s                                            | 接受：按 rev 去重；同一 cmdId 只建立一次固定的 effectDeadline；补「重复补发 + 每秒 tick」用例                                                                                                    | D8-4、U1                       |
| 5    | Major      | TUI 真实失败进不了 catch                                               | 接受：补能力边界表；新增 `returned`→REFUSED 判定；shutdown 之后的失败只报 LOST；补贴近真实宿主的用例                                                                                             | 事实 2/3、D3、A8–A10           |
| 6    | Major      | 兼容口径与新增发送行为不一致；对 slotFlush 的理解有误                  | 接受：投影无变化时零副作用；off/TUI 场景要求完整帧序列相等；跟踪场景声明两类允许差异并逐帧列清单；风险改写为断链/背压；补旧 decoder 与真实 agent-server→SSE 存证                                 | 事实 6、D6、G1–G3、U10、C1、§5 |
| 7    | Major      | Q3 与 #23 总截止存在竞态                                               | 接受：绝对截止保留且不延长；「不 cancel」只针对收到 IDLE_WAIT 那一刻；另存 cancelAt，到点照常 cancel；文案区分两种超时；补四种时序用例                                                           | D8 Q3 段、U4/U5                |
| 8    | Minor      | 进程级结构缺版本号、TTL 撤销方式不明                                   | 接受：`v:1` 纯数据，未知或损坏结构按空处理并覆盖；TTL 只约束读取，借现有 onTick 只发布一次撤销；UI 不按 at 判过期                                                                                | D5、A7/A12、C1                 |
| 9    | Minor      | tiers 归属、路径不精确、tier 先例写错、门禁缺 tests/commands           | 接受：`tests/tiers.ts` 只归 P-C；全部改为仓库精确路径；`epoch-up-compat` 更正为 TIER1_DECLARED；P-A 门禁加 `tests/commands`；反例全部纳入矩阵                                                    | 事实 8、§2、§4、§3             |
| r3-2 | 原 Major 2 | 「至多一个 life」推导不成立（now 的 5s await 可与另一次 now/调用重叠） | root 裁定：life 下加执行级 `execId`；合并请求只订阅结果；异步回调和回滚按 execId 校验、旧执行丢弃；**不加单飞门**，deferred reload 语义不变；补 A1/A2/A13                                        | D1、D2、A1–A3、A13             |
| r3-7 | 原 Major 7 | 同一 tick 内 IDLE_WAIT 与总截止竞争的规则自相矛盾                      | root 裁定：不论顺序，cancel **恰好一次**，最终原因统一为 `E_RELOAD_IDLE_WAIT`（属 Q4 允许的细化）；absorb、总截止回调、cancelAt 共用；U5 改为断言两种顺序结果一致                                | D8 Q3 段、U5                   |
| r3-8 | 原 Minor 8 | 记录读取缺时间规则                                                     | root 裁定：时间戳在未来或 `now - at < 0` ⇒ 按空处理并清除，补 A11/U11                                                                                                                            | D5、A11、U11                   |
