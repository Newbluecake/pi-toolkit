# Load-aware dispatch（`src/sysload/`）施工方案 v1

> 状态：方案（未实装）。最近先例：`docs/dev/quota/`（适配器 + TTL 缓存、turn_end 阶梯、spawn 快速失败闸门、HUD 行）
> 与 `docs/dev/quota-web/plan.md`（QuotaPill/QuotaCard）。本文行号均为「附近」，施工前以 HEAD 为准。

## 1. 目标与非目标

- 监控本机 CPU / 内存 / 磁盘，在 web hub（TopBar `LoadPill` + `LoadCard`）与 TUI HUD 展示。
- 负载过高时**只拦新派发**：主会话 `Agent` 在 crit 立即拒绝（零 run/label/worktree）；workflow `agent()` 排队等回落。
- 通过 turn_end 阶梯注入 + 恢复通知告诉主 agent，让它在「排查负载」与「等待回落」之间选择。
- 非目标：cgroup 配额感知（v1 读宿主 `/proc`，见 §13 Q4）、macOS/Windows 采样（非 Linux ⇒ `unknown`）、
  自动 kill 进程、对已在跑的 run 降速/暂停、跨进程共享采样结果。

## 2. 用户裁决（2026-10-10，本方案不得偏离）

| #   | 裁决                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | workflow `agent()` 在 crit 时**排队**（受 workflow 自身预算/排队超时语义约束）；主会话 `Agent` **立即拒绝**（同 quota L3 fast-fail），消息带负载明细 + top 进程 + 两个选项（排查/等待）。系统内部 run 逐项判定豁免（§6.3）。                                                                                                                                               |
| U2  | 默认阈值（持续 ≥60 s 才升级，迟滞降级）：CPU busy ≥85% 或 PSI cpu some avg10 ≥40% ⇒ warn；≥95% 或 ≥70% ⇒ crit。MEM available ≤15% ⇒ warn，≤8% ⇒ crit。DISK free ≤10% ⇒ warn，≤5% 或 ≤5 GB ⇒ crit（挂载点：`$HOME`、session cwd、`/` 所在文件系统）。全部 `load.*` 可调，`load.enabled` 总开关。                                                                            |
| U3  | Web：TopBar `LoadPill` 紧挨 QuotaPill（`CPU 72% · MEM 81% · DISK 64%`，英文紧凑 token，warn/crit 着色；≤480px 只显示最差项），点击 ⇒ `LoadCard` popover（各指标条、loadavg、PSI、分挂载磁盘、top-5 by CPU / by RSS、sampled-at）；crit 时 fleet drawer 顶部横幅「负载过高，已暂停派发新子 agent」；TUI HUD 在 quota 行旁加 load 行。视觉稿另行产出，本方案只定结构与数据。 |
| U4  | 数据流：pi-free 采样模块被 (a) pi 侧（闸门 + 阶梯 + HUD，web hub 关闭也必须可用）与 (b) hub 进程（自采样，经新 SSE 事件推浏览器）共用。非 Linux/不可读 ⇒ `unknown` ⇒ 永不拦（fail-open）。阈值硬编码默认、settings 暴露。                                                                                                                                                  |
| U5  | 主 agent 通知：turn_end 阶梯注入（升 warn / 升 crit / 恢复），中文散文块，紧凑标记纯英文；被拒派发后负载回落时补一条恢复通知，零额外定时器（只用采样节拍，全部 unref）。                                                                                                                                                                                                   |

## 3. 架构与数据流

```
            ┌──────────── src/sysload/ (pi-free: procfs/reader/top/levels/wire) ────────────┐
            │                                                                              │
 pi 主会话 (post-guard)                                               hub 进程 (src/web-hub/hub/load.ts)
 LoadService: 5s unref 节拍 → readSample → LoadTracker → verdict       同一 reader+tracker，阈值来自 HubConfig.load
   ├─ spawn-service 准入闸门（同步读 verdict，loadPolicy:"reject"）     ├─ bus HubEvent{type:"load"} → http.ts 直推 SSE `load`
   ├─ workflow host 排队（ChildSpawner.loadAdmission）                  │   （不进 replay ring；连接时补发最新快照）
   ├─ turn_end 阶梯 hook（sendMessage triggerTurn:false）               └─ GET /api/load/top（按需、单飞、2s 缓存）
   ├─ 恢复唤醒（仅曾拒绝过；consume-once）
   ├─ HUD status key "load"
   └─ StatusInfo.loadGate（经 web-hub agent，可选）→ drawer 横幅
```

- **两处独立采样是刻意的**：闸门必须在 hub 关闭时工作，且不能引入跨进程故障面；hub 侧只负责展示。两边阈值同源
  （`buildHubConfig` 把 `load.*` 塞进 `HubConfig.load`），边界时刻可能短暂不一致：Pill 显示 hub 视角，drawer 横幅显示
  **该会话真实闸门状态**（`StatusInfo.loadGate`），以后者为准。
- 多个 pi 进程各自采样：每节拍 ≈6 个小 procfs 读 + ≤3 次 `statfs`，10 个会话也可忽略；子 agent 会话（post-guard）不采样。
- 采样只在主会话 stack 存在时运行；`ctx.mode` 为 print/json 时 hook 不注入，但 service 仍可为闸门服务（RPC 主进程场景）。

## 4. 模块布局（新增 `src/sysload/`，除 hook.ts 外零 pi import）

| 文件         | 职责                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`   | **P0 冻结面**：`LoadLevel = "ok"\|"warn"\|"crit"\|"unknown"`、`LoadSample`、`MetricVerdict`、`LoadVerdict`、`TopProc`、`LoadTop`、`LoadThresholds`、`LoadService` 接口、`LoadAdmission`（workflow 用）。                                                                                                          |
| `procfs.ts`  | 纯解析：`parseProcStat`（cpu 行 → total/idle/iowait ticks、核数）、`parseMeminfo`（MemTotal/MemAvailable）、`parseLoadavg`、`parsePressure`（some/full avg10）、`parsePidStat`（comm/utime/stime/starttime，comm 含括号/空格的健壮切分）、`parsePidStatm`。                                                       |
| `reader.ts`  | 有界 IO：`readSample(io, opts)`，`fs.promises` + `withDeadline(tickDeadlineMs=1000)`；挂载解析：对 `$HOME`/cwd/`/` 做 `stat().dev` 去重、60 s 缓存；每挂载 `statfs` 单飞（在途未回不再发起，防 NFS 卡死积压 libuv 线程，同 worktree-sampler zombie 护栏）。CPU% 来自相邻两次 `/proc/stat` 差分，首拍 `cpu` 缺省。 |
| `top.ts`     | `scanTop(io, prev, opts)`：枚举 `/proc/[0-9]*`，上限 `maxPids=4096`、并发 16、deadline 300 ms，超限返回 `partial:true`；CPU% 用与上次扫描的 tick 差分，无上次 ⇒ 生命周期平均并标 `cpuAvg:true`；RSS = statm resident × pagesize。只读 `comm`（≤16 字节、去控制字符），**绝不读 cmdline/environ**。                |
| `levels.ts`  | `classify(sample, thresholds)` 逐指标原始等级；`createLoadTracker({sustainMs, recoverMs, intervalMs})` 状态机（§6.1）。                                                                                                                                                                                           |
| `wire.ts`    | `projectLoadWire(verdict)` / `projectTopWire(top)` / `loadFingerprint`——hub 与 web-hub agent 共用，pi-free。                                                                                                                                                                                                      |
| `render.ts`  | `renderLoadStatus`（HUD）、`buildLoadHintText`、`buildLoadRecoveryText`、`buildLoadGateMessage`、`formatBytes`。                                                                                                                                                                                                  |
| `gate.ts`    | `evaluateLoadGate(verdict, {gateLevel, top, ownRuns, now})` → `{message}`\|undefined，零 IO 零 await。                                                                                                                                                                                                            |
| `hook.ts`    | `createLoadHintHook(deps)`（turn_end，照抄 `src/quota/hook.ts` 结构）+ `LoadHintState`。                                                                                                                                                                                                                          |
| `service.ts` | `createLoadService({clock, settings, io, cwd, home, setStatus?, onTransition?})`：单飞节拍、`verdict()`、`top()`、`onChange(fn)→unsub`、`noteRejected()`、`dispose()`（幂等，setStatus(undefined) 恰一次）。                                                                                                      |
| `index.ts`   | `createLoadStack(input)` barrel（`load.enabled=false` ⇒ undefined，全特性缺席）。                                                                                                                                                                                                                                 |

## 5. 协议新增（全部 additive，不升 proto）

- `src/web-hub/protocol/messages.ts`：
  - `LoadWire { v:1; at; level; since?; cpu?{busyPct,psiSome10?,cores,level}; mem?{usedPct,availBytes,totalBytes,psiSome10?,level};
io?{psiSome10?}; disks?{path,label,usedPct,freeBytes,totalBytes,level}[≤4]; loadavg?[3] }`，开放 schema（同 `QuotaWireSchema` 姿态）。
  - `LoadTopWire { at; partial?; byCpu: TopProcWire[≤5]; byRss: TopProcWire[≤5] }`，`TopProcWire { pid; comm; cpuPct?; cpuAvg?; rssBytes }`。
  - `StatusInfo.loadGate?: LoadGateWire { level; gating: boolean; since?; rejected?: number; queued?: number }`（会话闸门真相，
    缺席 = load 关/webHub.load 关/unknown——与 pre-feature 逐字节相同）。
- `src/web-hub/protocol/http-contract.ts`：`SSE_EVENTS` 在 `"spawns"` **之前**插入 `"load"`（保住 `.at(-1)==="spawns"` 钉）；
  `LOAD_TOP_PATH = "/api/load/top"`；无新错误码（复用 `E_RATE`/`E_BUSY`/`E_DEADLINE`/`E_NOT_FOUND`）。
- `src/web-hub/hub/ports.ts`：`HubEvent | {type:"load"; payload: LoadWire}`；`HubConfig.load?: HubLoadConfig`（阈值 + 节拍；键缺席即 off）。
- hub cap `load.v1`：`config.load` 存在且启动探针读通 `/proc/stat` 时声明；`ui/src/logic/contract.js` 同步镜像 SSE 名。

## 6. 阈值、状态机与闸门语义

### 6.1 状态机（每指标独立，总体 = 已知指标最高级；全部 unknown ⇒ unknown）

- 采样节拍 `load.sampleIntervalMs=5000`；环形窗口长度 `ceil(max(sustainMs,recoverMs)/interval)+1`（默认 13 条，几十字节）。
- **升级**：窗口覆盖满 `sustainMs=60000` 且其中每个样本原始等级 ≥ L ⇒ 进入 L（warn→crit 同理，可直接 ok→crit）。
- **降级（迟滞）**：最近 `recoverMs=30000` 内每个样本都低于「L 阈值 − 迟滞量」⇒ 降一级（crit→warn→ok 逐级）。迟滞量：
  CPU/PSI 5 点、MEM 3 点、DISK 1 点或 1 GB。
- **断档**：两样本间隔 > 2×interval（休眠/卡顿）⇒ 清空窗口重新计 sustain，已处等级保持直到 recover 判定或 stale。
- **stale**：最新样本早于 3×interval，或连续 3 拍读失败/超时 ⇒ 该指标 unknown ⇒ 闸门放行（R-fail-open）。
- CPU 原始等级 = max(busy 判定, PSI 判定)；无 `/proc/pressure`（旧内核/容器）只用 busy。DISK 等级 = 各挂载最差，crit 条件
  `freePct ≤5 || freeBytes ≤ 5 GiB`（小盘上 5 GB 规则可能常驻 crit，见 §12 R5）。
- `since` = 当前等级进入时刻；`onChange(prev,next)` 只在总体等级变化时同步回调（try/catch 每个监听器）。

### 6.2 Settings（`src/config/settings.ts` `LoadSettings` + `parseLoadSettings` 逐字段容错；`setting-specs.ts`）

`load.enabled`(true) · `load.gate`(true) · `load.gateLevel`("crit"|"warn"，默认 crit) · `load.sampleIntervalMs`(5000，min 1000) ·
`load.sustainMs`(60000) · `load.recoverMs`(30000) · `load.cpu.{warnPercent 85, critPercent 95, psiWarnPercent 40, psiCritPercent 70}` ·
`load.mem.{warnAvailPercent 15, critAvailPercent 8}` · `load.disk.{warnFreePercent 10, critFreePercent 5, critFreeGb 5, extraPaths ""}` ·
`load.hint.{enabled true, display true, repeatMs 600000, minIntervalMs 120000}` · `load.wakeOnRecovery`(true，见 Q1) · `load.hud`(true) ·
`load.topCount`(5) · `webHub.load`(true)。时长键进 `TIME_SETTING_MS_PATHS`；parse 钳制 warn/crit 单调（CPU warn≤crit、MEM/DISK warn≥crit）。
**非 live**：同 quota，session_start 捕获，改后 `/reload`；hub 侧阈值经 `HubConfig.load`，改后需 `/webhub restart`（spec 描述里写明）。

### 6.3 闸门：谁被拦、谁排队、谁豁免

| 入口                               | 行为                                | 理由                                                                                         |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| 主会话 `Agent`（含 `resume` 参数） | **reject**（`loadPolicy:"reject"`） | U1；resume 同样新建 run 会话、产生负载                                                       |
| 嵌套 `Agent`（子会话内）           | **reject**（同字段，嵌套版文案）    | 嵌套派发同样是新负载；子会话收不到恢复通知，文案改为「先不委派、自己做完或带说明交回」（Q2） |
| workflow `agent()`                 | **queue**（host 层，§6.5）          | U1；spawn 请求不带 `loadPolicy`，杜绝「host 判放行、service 判拒绝」竞态                     |
| consult fork                       | 豁免                                | 运行中 run 的同步工具调用，只读、短、已有成本/轮次上限；拒绝等于打断正在跑的 run             |
| `/goal` verifier                   | 豁免                                | 系统闭环的一环，只读短跑；拒绝会让 goal 误判为验证失败                                       |
| `/mem tidy`、`/task`、`@mention`   | 豁免                                | 用户显式意图，用户本人能看到 Pill；拒绝属越权（可在 TUI `notify` 一句 warn，非阻断）         |
| RPC spawn（`src/rpc/server.ts`）   | 豁免                                | 外部程序自有调度，同 timeoutPolicy「程序派生 run」家族（Q3）                                 |
| cron（`src/schedule/`）            | v1 豁免                             | 改动面在 scheduler；v2 候选「crit 时跳过本次并记日志」（Q3）                                 |

- `SpawnRequest.loadPolicy?: "reject"`（`src/core/types.ts`，紧挨 `poolFullPolicy`）；`request-threading.ts` 排除表登记
  「admission 消费，不下沉 RunnerSpec」。只有 `src/tools/agent-tool.ts` 的 `prepareSpawn` 写它（`deps.loadGate?.() ? "reject" : undefined`，
  `load.gate=false` ⇒ 字段缺席 ⇒ 逐字节同今天）。
- 挂点：`src/service/spawn-service.ts` 的零副作用准入区，**quota 闸门之后**（≈L685）、nesting/runId/label 之前；
  `deps.loadGate?: () => LoadGateVerdict | undefined` 同步只读。顺序含义：pool-full（已有，retryable）先于 load——两者并存时主 agent
  反正要等完成通知；类型/模型/额度错误优先暴露，避免「等负载回落后再撞配置错」。
- 拒绝形态：`{ kind:"config", message, retryable: true }`；同时 `loadService.noteRejected()` 计数（供恢复通知与 `loadGate.rejected`）。
- **不死锁**：闸门从不阻塞已在跑的 run，回落不依赖任何新派发；若负载正是自己的子 agent，拒绝文案列出本会话在跑 run 数与
  label（取自 SpawnService 快照，≤8 个），主 agent 可 `abort_subagent` 自救。workflow 排队受 workflow deadline 兜底（§6.5）。

### 6.4 通知（`customType: "subagent:load"`）

- **阶梯**（turn_end，`sendMessage(..., {triggerTurn:false})`，print/json 跳过）：先读后不刷（verdict 由节拍维护）；闩锁 =
  上次播报等级；升 warn / 升 crit 各播一次；crit 每 `repeatMs` 复读一次；降到 < gateLevel 且曾播 ≥warn ⇒ 恢复块；
  全局 `minIntervalMs` 地板（crit 与恢复绕过）；send 失败闩锁回滚（照抄 quota Minor 1/2）。
- **恢复唤醒**：节拍里 `onChange` 观测到总体等级跌破 gateLevel 且 `rejectedSinceRecovery>0` ⇒ 一次性
  `pi.sendMessage(恢复块, { triggerTurn: true })`（先例：workflow grace 通知 / `src/adapters/workflow-notice.ts`），并清零计数、
  同步更新 hook 闩锁避免下一个 turn_end 重复播。无拒绝 ⇒ 只走阶梯（triggerTurn:false）。不新增任何定时器。
- 文案（紧凑首行纯英文 token，后接中文散文）：

```
[load] crit · CPU 97% (PSI 74%) · MEM 6% avail · DISK / 3.1G free · since 14:02 (2m)
系统负载过高，已暂停派发新的子 agent：Agent 调用会被直接拒绝，workflow 的 agent() 会排队等待回落。
```

```
load gate: 系统负载过高（crit），本次派发已拒绝，未创建任何 run / label / worktree。
[load] crit · CPU 97% (PSI 74%) · MEM 6% avail · DISK / 3.1G free · since 14:02 (2m)
loadavg 18.2 / 15.1 / 9.8 (16 cores) · own runs 3 (fix-auth, review-x, …)
top cpu: node#4123 380% · cc1plus#9911 95% · … ｜ top rss: java#2210 9.8G · …
你可以二选一：① 排查负载来源（上列进程；可用 bash 跑 `ps`/`top -bn1`，若是自己派出的 run 可 abort_subagent）；
② 等待回落——直接结束本轮即可，负载回落后会收到一条 [load] 恢复通知并被唤醒，届时再派发。
（在 settings 文件里把 load.gate 设为 false 可关闭本闸门。）
```

```
[load] ok · CPU 41% · MEM 38% avail · DISK / 12G free
负载已回落（此前拒绝了 2 次派发），可以继续派发子 agent。
```

### 6.5 workflow 排队（`src/workflow/host.ts` + `spawner-adapter.ts`）

- `ChildSpawner.loadAdmission?: { blocked(): boolean; onClear(fn): () => void }`（可选；缺席 ⇒ 逐字节同今天）。
  `spawner-adapter.ts` 从 `WorkflowChildSpawnerOptions.loadAdmission` 透传，stack.ts 绑定到 LoadService（blocked ⇔ 等级 ≥ gateLevel 且非 unknown）。
- `handleAgent` 排队条件扩为 `waitQueue.length>0 || activeCount()>=maxParallel || loadBlocked()`；`pump()` 循环条件加 `&& !loadBlocked()`；
  host 创建时 `onClear(() => pump())`，`terminate`/`stopOwned` 时退订。`queued` 子事件加可选 `reason:"load"|"maxParallel"`，fleet 可见。
- 上界：沿用既有语义——排队中耗尽 workflow 预算 ⇒ withheld → `null`（`dispatchQueued` 的 `budget_exhausted` 分支、WT8
  `stopOwned`）；`extend_subagent_timeout wf_…` 可延长。replay 命中不受闸门影响（不产生新 run）。

## 7. UI 规格

- `ui/src/logic/load.js`：`reduceLoad`、`worstMetric(wire)`、`formatLoadTokens`、`levelClass`；`logic/state.js` 加 `case "load"`
  （覆盖语义，非法 payload 整体丢弃，同 `spawns`）；`useHub` 透传 `load.v1` cap。
- `components/load/LoadPill.vue`：TopBar 中 QuotaPill 之后；无 `load` 数据或 cap 缺席 ⇒ 零 DOM（沿用 TopBar 0/1 项 `v-for` 技巧）。
  文本 `CPU 72% · MEM 81% · DISK 64%`（MEM/DISK 显示 used%，DISK 取最差挂载）；`unknown` 指标省略；≤480px 只显示最差项；
  warn/crit 用既有 token 色；`aria-label` 走 i18n。
- `components/load/LoadCard.vue`：popover（复用 QuotaCard 的 clamp/flip），每指标一条 bar + 阈值刻度；loadavg、PSI cpu/mem/io；
  分挂载磁盘（label `~`/cwd/`/`，free/total）；打开时 `GET /api/load/top`（X-PWH:1，失败显示「unavailable」不重试风暴）列 top-5 by CPU / by RSS；
  底部 `sampled HH:MM:SS`（>15 s 标 stale）。
- fleet drawer（`components/drawer/FleetDrawer.vue`）：当前会话 `status.loadGate.gating===true` ⇒ 顶部横幅
  `i18n load.banner`（zh「负载过高，已暂停派发新子 agent」/ en「Load critical — new subagent dispatch paused」），附 rejected/queued 计数。
- i18n：新命名空间 `i18n/{en,zh}/load.ts`（glob 收录，parity 测试自动覆盖）；样式 `styles/load.css`（`ld-` 前缀、token-only）。
- TUI HUD：status key `"load"`，`src/hud/footer.ts` 把 `"load"` 加入 `OWN_LINE_STATUS_KEYS`；能放下时与 quota 同行
  （`load … │ quota …`），否则 load 独占一行排在 quota 前；文本 `load CPU 72% · MEM 81% · DISK 64%`，warn/crit 着色，unknown ⇒ 不设。
- gzip 预算：Pill+Card+logic 估 +3~4 KiB gz；合入时由主会话在干净 worktree 实测，必要时把 `scripts/web-hub/check-ui-dist.ts`
  的 `JS_BUDGET_GZIP_BYTES` 从 232 KiB 提到 236 KiB 并按惯例补「Budget history」注释。

## 8. 不变量

- I1 fail-open：unknown/stale/读失败/非 Linux ⇒ 不拦、不排队、不注入告警。
- I2 只拦新派发：已在跑的 run 永不受影响；回落不依赖任何派发。
- I3 拒绝零副作用：load 闸门在准入区，先于 runId/label/resumeLocks/nesting/worktree 任何写入。
- I4 零新增定时器：pi 侧唯一节拍为 LoadService 的 unref'd 周期定时器（经 `systemClock.setTimer`）；hub 侧一个，同样 unref，且不计入 idle 活动。
- I5 硬 deadline：每拍 IO ≤1 s、top 扫描 ≤300 ms、`statfs` 单飞；在途未回不叠发；`/api/load/top` 受 req-deadline。
- I6 无模块级可变状态：service/tracker/hint state 全挂 Stack，`/reload` 经 session_shutdown dispose；`previousLoad` 交接同 quota。
- I7 注入通道：阶梯 `triggerTurn:false`；仅「曾拒绝后的恢复」一次性 `triggerTurn:true`；绝不写 systemPrompt。
- I8 `load.enabled=false` / `webHub.load=false` / `config.load` 缺席 ⇒ 对应面逐字节同 pre-feature（无 cap、无 SSE 帧、无 status 字段、无 HUD 键）。
- I9 hub 导入图 pi-free：hub 只 import `sysload/{procfs,reader,top,levels,wire,types}`，由 `tests/web-hub/boundary.test.ts` 钉住。
- I10 隐私：只暴露 `comm` 与 pid，绝不读 cmdline/environ；磁盘 path 在 LAN 可见（U1 单 LAN 用户裁决同口径，Q5）。

## 9. 测试计划

- `tests/sysload/procfs.test.ts`：fixture 文本（含 comm 带 `) (` 的进程、缺 pressure、截断行）。
- `tests/sysload/levels.test.ts`：sustain 未满不升、整窗才升、迟滞降级逐级、断档清窗、stale→unknown；seeded property：
  任意序列下等级只在窗口条件满足时变化、unknown 永不升 crit。
- `tests/sysload/reader.test.ts` / `top.test.ts`：假 io（挂起的 statfs ⇒ deadline + 单飞不叠发；4096 上限 ⇒ partial；cpuAvg 回退）。
- `tests/sysload/gate.test.ts`、`render.test.ts`：文案快照（紧凑行无中文）、own runs 截断。
- `tests/sysload/hook.test.ts` + `tests/integration/load-turn-end-wiring.test.ts`：照抄 quota 的 fakePi/ctx/holder；升级/复读/恢复/回滚/print 跳过；
  恢复唤醒仅在 rejected>0 时 `triggerTurn:true` 且只一次。
- `tests/config/load-settings.test.ts`：逐字段容错、单调钳制、TIME 路径。
- `tests/service/load-gate.test.ts`：reject 不产生 run/label/worktree；`loadPolicy` 缺席放行；unknown 放行；与 pool-full、quota 顺序；
  同 tick 多次 spawn 一致。`tests/tools/agent-tool` 金样（含 nested surface golden）若受字段影响需同步。
- `tests/workflow/load-queue.test.ts`：blocked ⇒ queued(reason load)；onClear ⇒ pump FIFO；deadline ⇒ withheld null；退订无泄漏；无 loadAdmission 逐字节同。
- `tests/hud/footer` 增补：load+quota 同行/分行。
- hub：`tests/web-hub/hub/load.test.ts`（无 config.load ⇒ 无 cap/无帧；有 ⇒ 连接补发 + 直推不进 ring；top 端点 X-PWH、单飞、2 s 缓存、LAN 同宽）。
- UI：`tests/web-hub/ui/logic-load.test.ts`、`load-pill.test.ts`（零数据零 DOM、窄屏最差项、着色）、drawer 横幅、`logic-contract`/`i18n-parity` 自动覆盖。
- 全量：`npm run format:check && npm run typecheck && npm test && npm run build`；UI 包另加 `build:web && check:web`（干净 worktree）。

## 10. 包切分与独占文件域

热点共享文件（任何并行包不得并发改，按下表独占或串行）：`src/config/settings.ts`、`src/config/setting-specs.ts`、
`src/core/types.ts`、`src/service/request-threading.ts`、`src/web-hub/protocol/{messages,http-contract}.ts`、`src/web-hub/hub/ports.ts`、
`ui/src/logic/contract.js`、`src/stack.ts`、`src/index.ts`、`src/tools/agent-tool.ts`、`src/hud/footer.ts`、`src/web-hub/hub/{hub,http,main}.ts`、
`src/web-hub/agent/{index,status}.ts`、`scripts/web-hub/check-ui-dist.ts`、`AGENTS.md`。
**前置**：当前工作树对 `setting-specs.ts`、`core/types.ts`、`agent-tool.ts`、`hub.ts`、`http.ts` 等有未提交的在飞改动——P0 必须等其落地（或在其 commit 之上开工）。

| 包                                   | 文件域（独占）                                                                                                                                                                                                                                                                          | 允许新建                         | 冻结面                                                          | 依赖 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- | ---- |
| **P0 冻结面**（串行，先行）          | `src/sysload/types.ts`；`settings.ts`/`setting-specs.ts` 的 load 段；`core/types.ts` 加 `loadPolicy`；`request-threading.ts` 排除表一行；`protocol/messages.ts`、`http-contract.ts`、`hub/ports.ts` 的 load 类型；`ui/src/logic/contract.js` 镜像；`tests/config/load-settings.test.ts` | `src/sysload/types.ts`、上述测试 | 其余全部                                                        | 无   |
| **P1 sysload 核心**                  | `src/sysload/**`（types.ts 除外）、`tests/sysload/**`                                                                                                                                                                                                                                   | 仅这两处                         | P0 全部产物                                                     | P0   |
| **P4 Web UI**（与 P1 并行）          | `ui/src/components/load/**`、`ui/src/logic/load.js`、`ui/src/styles/load.css`、`ui/src/i18n/{en,zh}/load.ts`、`TopBar.vue`、`drawer/FleetDrawer.vue`、`logic/state.js`（仅 `case "load"`）、`tests/web-hub/ui/{logic-load,load-pill,load-banner}.test.ts`                               | 仅上述目录                       | protocol/**、hub/**、其余 i18n、check-ui-dist                   | P0   |
| **P2a pi 接线**                      | `spawn-service.ts`、`agent-tool.ts`、`stack.ts`、`index.ts`、`hud/footer.ts`、`web-hub/agent/{index,status}.ts`（loadGate 字段 + `buildHubConfig` 的 `load`）、`tests/service/load-gate.test.ts`、`tests/integration/load-turn-end-wiring.test.ts`、footer/agent-tool 相关测试          | 测试文件                         | `src/sysload/**`（只 import）、`src/workflow/**`                | P1   |
| **P2b workflow 排队**（与 P2a 并行） | `src/workflow/{host,spawner-adapter}.ts`（含 `ChildSpawner`/`WorkflowChildSpawnerOptions` 新可选字段）、`tests/workflow/load-queue.test.ts`                                                                                                                                             | 该测试                           | stack.ts（由 P2a 接 `loadAdmission`，P2b 只定义字段并上报签名） | P1   |
| **P3 hub 侧**（与 P2a/P2b 并行）     | `src/web-hub/hub/load.ts`（新）、`hub/{hub,http,main}.ts`、`tests/web-hub/hub/load.test.ts`、`tests/web-hub/boundary.test.ts`（若需扩白名单）                                                                                                                                           | `hub/load.ts`、测试              | protocol/**、agent/**、`src/sysload/**`                         | P1   |
| **P5 收口**（主会话）                | `AGENTS.md`（新增 `src/sysload/` 条目 + web-hub load 段）、`check-ui-dist.ts` 预算、本文修订记录                                                                                                                                                                                        | —                                | —                                                               | 全部 |

- P2a 与 P2b 的唯一耦合是 `WorkflowChildSpawnerOptions.loadAdmission` 签名：P0 已在 `types.ts` 冻结 `LoadAdmission`，P2b 引用它；
  P2a 在 stack.ts 构造 `createWorkflowChildSpawner(..., { loadAdmission })`。该可选字段由 P2b 新增，P2a 传它需 P2b 已在树上，故**合并顺序 P2b → P2a**（P2a 开发期可先写好调用、合入前 rebase 到 P2b 之上再跑 typecheck）。
- 派单前跑 `conflict-check.mjs`；各包自提交精确路径、commit 前缀 `[sysload:Pn]`；验收模型 ≠ 开发模型（dev-flow）。
- 车道：L3（跨 pi/hub/UI 三面、新协议、改准入），走完整闸门；P0 评审通过再放 P1/P4。

## 11. 关键接线细节（P2a/P3 速查）

- stack.ts：顶部 `let previousLoad`、build 顶部 dispose；`loadRef` 晚绑定（spawn-service 构造早于 load stack，同 `quotaRef`）；
  `createSpawnService({... loadGate: settings.load.gate ? () => evaluateLoadGate(loadRef.current?.service.verdict(), …) : undefined })`；
  `Stack.load?`/`loadHint?`；HUD `ctx.ui.setStatus("load", …)`（`hasUI` + try/catch）。`index.ts`：guard 之后注册 `pi.on("turn_end", createLoadHintHook(...))`，
  session_shutdown 里 `holder.current.load?.dispose()`；`agentToolDeps.loadGate = () => settings.load.enabled && settings.load.gate`。
- hub：`hub.ts` 在 `config.load` 存在时构造 `createHubLoadSampler({clock, config.load, publish: e => registry.publish(e)})`，
  stop 时 dispose；`http.ts` `onHubEvent` 加 `case "load"`：遍历 `sse.list()` 直发（不进 ring，避免 5 s 一帧冲掉 8192 环）；
  `openEvents` 在 `spawns` 之后补发最新快照；新路由 `GET /api/load/top`（两 listener 同宽，`webHub.load=false` ⇒ 404）。
- hub 采样只在 hub 存活期间运行（hub 本身无 agent 即 idle-exit），推送按 `loadFingerprint`（整数百分比 + 等级）去重，最慢 15 s 心跳一帧。

## 12. 风险

- R1 PSI/`/proc/meminfo` 在容器内反映宿主而非 cgroup ⇒ 误判（Q4）；MemAvailable 缺失（<3.14 内核）⇒ mem unknown。
- R2 CPU busy 被自身编译/测试短时打满：60 s sustain + 30 s 恢复窗吸收；长构建确实会拦派发——这正是设计意图，文案引导排查。
- R3 `triggerTurn:true` 恢复唤醒打断用户空闲态（Q1）；有 rejected 门槛 + consume-once，频率受等级迟滞约束。
- R4 statfs 卡在网络盘：单飞 + deadline，最坏是该挂载 unknown；被卡住的 libuv 线程最多 1 个/挂载。
- R5 小盘（<100 GB）上 `≤5 GB` crit 规则可能常驻 crit ⇒ 永久拒派发；缓解：文案指明是 DISK 触发 + `load.disk.critFreeGb` 可调（Q6）。
- R6 hub 与 pi 视角短暂不一致（§3）；R7 在飞未提交改动与热点文件冲突（§10 前置）；R8 gzip 预算余量不足需提额。

## 13. 待决问题

- Q1 恢复唤醒是否默认开（`load.wakeOnRecovery=true`，`triggerTurn:true`）？推荐开，仅曾拒绝后、每次回落至多一条。
- Q2 嵌套 `Agent` 是否也拒绝（本方案：是，文案改为「不委派、自己完成或交回」），还是豁免？
- Q3 RPC spawn 与 cron 是否也应受闸门（推荐 v1 豁免，v2 cron 改「crit 跳过本次 + 日志」）？
- Q4 是否读 cgroup v2（`memory.max`/`cpu.max`/`cpu.pressure`）以适配容器？推荐 v2。
- Q5 LAN 上是否暴露 top 进程与磁盘路径（推荐暴露，同 bash-jobs 面板 U1 口径；可加 `webHub.load:"loopback"`）。
- Q6 DISK 是否单独使用更短 sustain（磁盘变化缓慢、无抖动，可 0 s 立即升级）？当前按 U2 统一 60 s。
- Q7 `/agent status` 是否附一行 load 摘要（低成本，推荐顺手做，归 P2a）。

## 14. 用户裁定（第二轮，2026-10-10）

- Q1 恢复**不唤醒**：`load.wakeOnRecovery` 默认 false / v1 不做唤醒，只在下一次 turn_end 注入恢复提示（`triggerTurn:false`）。
- Q2 嵌套 `Agent` 在 crit **也拒绝**（文案：不委派，自己完成或交回上层）。
- Q5 LAN 与 loopback 同宽，展示 top 进程与磁盘挂载路径（同 bash-jobs 面板 U1 口径）。
- 视觉稿确认，附三处微调：① top 进程两列都按进程名聚合（展开看 pid）；② 磁盘行在百分比旁显示剩余容量（如 `58% · 112G free`）；③ fleet 横幅的持续时长并入同一行小字。
- 主会话代决（按方案推荐）：Q3 RPC/cron v1 豁免；Q4 cgroup v2 支持留到 v2；Q6 磁盘与其它指标统一 60 s sustain；Q7 `/agent status` 附一行 load 摘要（归 P2a）。
