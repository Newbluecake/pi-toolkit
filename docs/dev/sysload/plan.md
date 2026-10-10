# Load-aware dispatch（`src/sysload/`）施工方案 v2.1

> 状态：方案 v2.1（v1 = 9b11bd6 打回 16 条 → §14；v2 复审 conditional_pass，Major 1–6 修入正文、Minor 7–10 记入包注 → §15）。先例：`docs/dev/quota/`、`docs/dev/quota-web/plan.md`、
> `docs/dev/web-hub-session-history/plan.md`（libuv 饥饿门）。行号均为「附近」，施工前以 HEAD 为准。视觉稿已获批（`/home/bluecake/snap/chromium/common/pwh-sysload/*.png`：
> topbar-light-1280 / loadcard-{light,dark}-760 / fleet-crit-light-760 / mobile-390），附 §2 第二轮三处微调。

## 1. 目标与非目标

- 监控本机 CPU / 内存 / 磁盘，展示于 web hub（`LoadPill`+`LoadCard`，**主机全局视角**）与 TUI HUD（**会话视角**）。
- 负载过高只拦**新派发**：`Agent`（主会话 + 嵌套）在 crit 立即拒绝、零副作用；workflow `agent()` 在 host FIFO 排队；turn_end 阶梯告知主 agent
  （升 warn / 升 crit / 一次恢复提示），由它选择排查或等待。
- 非目标（v1）：cgroup v2、非 Linux、远程/未知文件系统、自动唤醒、已在跑 run 的限速、跨进程共享样本、计数聚合（rejected/queued 次数）、可配置 top 数与额外路径。

## 2. 用户裁决（不得偏离）

| #      | 裁决                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1     | workflow `agent()` crit 时**排队**；`Agent` **立即拒绝**（同 quota L3 fast-fail），消息含负载明细 + top 进程 + 排查/等待两选项；系统内部 run 逐项豁免（§6.3）。                                                                       |
| U2     | 默认阈值，持续 ≥60 s 升级、迟滞降级：CPU busy ≥85% 或 PSI cpu some avg10 ≥40% ⇒ warn，≥95% 或 ≥70% ⇒ crit；MEM available ≤15% ⇒ warn，≤8% ⇒ crit；DISK free ≤10% ⇒ warn，≤5% 或 ≤5 GiB ⇒ crit。`load.*` 可调，`load.enabled` 总开关。 |
| U3     | TopBar `LoadPill` 紧挨 QuotaPill（`CPU 72% · MEM 81% · DISK 64%`，≤480px 只显示最差项）→ `LoadCard`；crit 时 fleet drawer 横幅「负载过高，已暂停派发新子 agent」；HUD 在 quota 行旁加 load 行。                                       |
| U4     | pi-free 采样模块被 pi 侧（闸门/阶梯/HUD，hub 关闭也工作）与 hub 进程（自采样，新 SSE 事件）共用；非 Linux/不可读 ⇒ `unknown` ⇒ 永不拦。                                                                                               |
| U5→Q1  | **v1 不做恢复唤醒**：恢复只在下一次 turn_end 注入提示（`triggerTurn:false`）；全程零新增定时器（仅采样节拍，unref）。                                                                                                                 |
| Q2     | 嵌套 `Agent` crit 时也拒绝（文案：不委派，自己完成或交回上层）。                                                                                                                                                                      |
| Q5     | LAN 与 loopback 同宽（top 进程、磁盘挂载路径均展示，同 bash-jobs 面板 U1 口径）；仍须正常鉴权与限流（§7.3）。                                                                                                                         |
| 视觉稿 | 获批 + 三处微调：① top 两列按进程名（comm）聚合，展开看 pid；② 磁盘行百分比旁显示剩余（`58% · 112G free`）；③ fleet 横幅持续时长并入同一行小字。                                                                                      |
| 代决   | Q3 RPC/cron v1 豁免；Q4 cgroup v2 延后；Q6 磁盘同为 60 s sustain；Q7 `/agent status` 附一行 load 摘要（归 P2a）。                                                                                                                     |

## 3. 架构与数据流

```
src/sysload/（pi-free）：procfs 解析 · mountinfo 过滤 · IO 账本 · 采样器 · 等级追踪器 · top 扫描 · wire 投影
 ├─ pi 主会话（post-guard，仅 interactive / rpc 模式启动）：LoadActivation（activate() 闭包持有）
 │    5 s 节拍 → sample → tracker → verdict（HOME、session cwd、/ 三路径）
 │    ├─ spawn-service 准入闸门（同步读 verdict；Agent 顶层 + 嵌套经 runtime-adapter）
 │    ├─ workflow host FIFO 排队（ChildSpawner.loadAdmission，gateCleared 时 pump）
 │    ├─ turn_end 阶梯 hook（triggerTurn:false，单槽恢复提示）· HUD status key "load" · `/agent status` 摘要行
 │    └─ StatusInfo.loadGate{gating,level,sinceAgoMs}（web-hub agent）→ drawer 横幅（会话闸门真相）
 └─ hub 进程（src/web-hub/hub/load.ts，cwd=HOME）：主机全局视角，路径仅 HOME 所在 FS + /
      HubConfig.load（hub 启动时由拉起它的 pi 写入，singleton 保留到 restart）
      → SSE `load`（直发、无 id、不进 ring；连接时在 spawns 之后补发）· GET /api/load/top（按需）
```

- pi 与 hub 各自采样、阈值各自来自本进程配置：**不承诺两边一致**。Pill/Card 标注「主机 · hub 视角」并在 Card 底部披露阈值来源
  （「阈值取自 hub 启动配置 · v<pluginVersion>」，`thresholds` 随 wire 下发）；drawer 横幅只读 `StatusInfo.loadGate`，是该会话闸门真相。
- print/json 模式**不启动**采样（闸门惰性放行）：实测（`tests/integration/web-hub-history-starvation.test.ts` 头注）一个挂起的线程池
  操作会阻塞 `process.exit`，print 模式不能冒此险。子 agent 会话（post-guard）不采样。多 pi 进程各自采样，单进程每拍 ≈5 次同步 procfs 小读 + ≤3 次 statfs。

## 4. 模块布局（`src/sysload/`，除 `hook.ts` 外零 pi import）

| 文件                                | 职责                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                          | **P0 冻结**：`LoadLevel`、`LoadSample`、`MetricState`、`LoadVerdict{level, gating, metrics, mono, at}`、`LoadTransition{gateCleared, provenRecovered, escalatedTo?}`、`TopSnapshot`、`LoadThresholds`、`LoadPort`（stack/runtime-adapter/web-hub 只见此接口）、`LoadAdmission{blocked(), onGateCleared(fn)→unsub}`。 |
| `procfs.ts`                         | 纯解析：`parseProcStat`、`parseMeminfo`、`parseLoadavg`、`parsePressure`、`parsePidStat`（comm 取首 `(` 与末 `)` 之间）、`parsePidStatm`、`parseMountinfo`（`\040` 等八进制解码）。                                                                                                                                  |
| `mounts.ts`                         | `resolveMounts(paths, mountinfoText)`：字符串最长前缀匹配（**不 realpath**，避免触发远程 FS），fstype 白名单过滤（§5.4）。                                                                                                                                                                                           |
| `io-ledger.ts`                      | 未完成 IO 账本：`Symbol.for("pi-subagent:sysload-io")` 进程全局（唯一状态例外，§8 I6），每 key ≤1、全局 ≤2；满则跳过不排队。                                                                                                                                                                                         |
| `sampler.ts`                        | `sampleOnce(io, plan, ledger, gen)`：系统 procfs 用**同步**有界读（≤64 KiB，内核全局文件不走线程池）；statfs 走异步 + 账本 + 1 s 响应期限。                                                                                                                                                                          |
| `tracker.ts`                        | 每指标/每挂载等级状态机（§5.2），单调时钟驱动；输出 verdict + transition。                                                                                                                                                                                                                                           |
| `top.ts`                            | 按需 top 扫描（§5.5）。                                                                                                                                                                                                                                                                                              |
| `wire.ts` / `render.ts` / `gate.ts` | wire 投影 + 指纹；HUD/提示/拒绝文案；`evaluateLoadGate(verdict, req, ctx)` 零 IO。                                                                                                                                                                                                                                   |
| `activation.ts`                     | `createLoadActivation(deps)`：`start(ctx)`/`stop()`/`port()`/`dispose()`，generation 计数，迟到结果丢弃。                                                                                                                                                                                                            |
| `hook.ts`                           | `createLoadHintHook(deps)`（照抄 `src/quota/hook.ts` 回滚纪律）。                                                                                                                                                                                                                                                    |

## 5. 公式、阈值与状态机（冻结）

### 5.1 公式与单位

- CPU：`/proc/stat` `cpu` 行 `user nice system idle iowait irq softirq steal guest guest_nice`；user/nice 已含 guest/guest_nice ⇒
  `total = user+nice+system+idle+iowait+irq+softirq+steal`（**不加** guest*）；`idleAll = idle+iowait`（iowait 视为空闲，IO 压力只经 PSI io 展示）；
  `busyPct = 100×(Δtotal−ΔidleAll)/Δtotal`。任一 Δ<0、Δtotal=0、非有限 ⇒ 该拍 CPU `invalid` 并重置基线。`cores` = `cpuN` 行数。
- PSI：`/proc/pressure/cpu` `some avg10`（百分比）；缺文件 ⇒ 仅用 busy。memory/io PSI 只展示。
- MEM：`MemTotal`/`MemAvailable` 单位 KiB ×1024；无 `MemAvailable` ⇒ unknown；`availPct = 100×avail/total`，展示 `usedPct = 100−availPct`。
- DISK：`statfs(mountPoint, {bigint:true})`；`freeBytes = bavail×bsize`，`totalBytes = blocks×bsize`，
  `freePct = 100×bavail/(blocks−bfree+bavail)`（df 语义，排除保留块）；全文 GiB = 2³⁰，UI 后缀 `G` 即 GiB。
- 设置改名：`critFreeGb` ⇒ `critFreeGiB`。

### 5.2 状态机（每指标；DISK 每挂载各一份；总体 = 已知指标最高级，全部 unknown ⇒ unknown）

- 时间：窗口/stale/since 全用注入的 `mono()`（`performance.now()`）；**定时器同样单调**：`createSegmentedClock({ now: mono, set: unref setTimeout })`
  （`src/core/clock.ts` 已支持注入 now），不用 Date.now 版 `systemClock`；`Date.now()` 只作展示 `at`。
- 符号绑定**本进程有效 settings**（parse 钳制后）：`B_L`=`load.cpu.{warn,crit}Percent`、`P_L`=`load.cpu.psi{Warn,Crit}Percent`、`A_L`=`load.mem.{warn,crit}AvailPercent`、
  `F_L`=`load.disk.{warn,crit}FreePercent`、`G_crit`=`load.disk.critFreeGiB×2³⁰`；裕量常量 `mCPU=5`、`mMEM=3`、`mDISK%=1`、`mDISKB=1 GiB`；默认即 U2。
- 原始等级（含等号）：CPU `crit ⇔ busy≥B_crit ∨ psi≥P_crit`，`warn ⇔ busy≥B_warn ∨ psi≥P_warn`；MEM `crit ⇔ avail≤A_crit`，`warn ⇔ avail≤A_warn`；
  DISK `crit ⇔ freePct≤F_crit ∨ freeBytes≤G_crit`，`warn ⇔ freePct≤F_warn`。
- 升级到 L：自上次迁移起一段**不间断**的有效样本序列，每个原始等级 ≥ L，且 `last.mono − first.mono ≥ sustainMs`（样本数不作证明）；
  `sustainMs=0` ⇒ 首个有效合格样本立即升级。可直接 ok→crit。
- 恢复谓词 `clear(L)`（严格不等，带裕量）：CPU `busy < B_L−mCPU ∧ (无 PSI ∨ psi < P_L−mCPU)`；MEM `avail > A_L+mMEM`；
  DISK `freePct > F_L+mDISK% ∧ (L≠crit ∨ freeBytes > G_crit+mDISKB)`。不间断有效样本序列全满足 `clear(L)` 且 `last.mono − first.mono ≥ recoverMs`
  ⇒ 降一级（crit→warn→ok 逐级）；序列中任一样本不满足 ⇒ 序列重开。
- **每次迁移后窗口清空**：下一次升/降只统计迁移之后的样本（新恢复窗口）。
- 连续性：两有效样本间隔（mono）> 2×interval，或 `invalid` 样本，或挂载身份（mountinfo mount ID + 主次设备号）变化 ⇒ 打断序列、保持当前等级；
  距最后有效样本 > 3×interval ⇒ 该指标 `unknown`。**新鲜度在读取时强制**：`port.verdict()` / `loadAdmission.blocked()` / 拒绝判定每次用当前
  `mono()` 重算 stale，绝不信任上一拍缓存的等级（节拍停摆也不会残留 crit）。从 unknown 恢复：空序列起算，满足 recoverMs 的 `clear(warn)` 序列确立 `ok`，
  满足 sustainMs 的 ≥L 序列确立 L；确立前保持 unknown（fail-open）。
- 上限：`sampleIntervalMs ∈ [2000,60000]`（默认 5000）、`sustainMs ∈ [0, 120×interval]`、`recoverMs ∈ [interval, 120×interval]`；
  环最多 128 槽；parse 越界即钳并 warn；warn/crit 单调钳制（CPU warn≤crit，MEM/DISK warn≥crit）。

### 5.3 迁移信号（取代 v1 的单一 onChange）

- **有效闸门** `gating = load.enabled ∧ load.gate ∧ 总体已知等级 ≥ gateLevel`（unknown ⇒ false），在 port 内单点计算；Agent / 嵌套 Agent /
  workflow `blocked()` / 迁移信号 / `StatusInfo.loadGate` / drawer 横幅 / 全部文案只读它，不各自重组。`load.gate=false` ⇒ 恒 false：不拒绝、
  不排队、无横幅，阶梯文案改用「仅提示（闸门已关闭，派发不受限）」句式，绝不出现「已暂停派发」。
- `gateCleared`：gating true→false（含 →unknown）。只用于唤起 workflow `pump()` —— fail-open。
- `provenRecovered`：某指标由 ≥gateLevel 经 §5.2 恢复谓词确立到**已知**低于 gateLevel，且总体随之 <gateLevel（按等级判定，与 gate 开关无关；
  gate 关时恢复文案不写「可以继续派发」）。只有它产生恢复提示。

### 5.4 挂载发现与 IO 纪律（Blocker #1）

- 发现：同步读 `/proc/self/mountinfo`（≤1 MiB、≤10 000 行，超限 ⇒ 磁盘 unknown），mono 60 s 刷新；最长前缀匹配按**路径分量边界**（`/home` 不匹配 `/homework`）。
- symlink 保守策略：HOME / cwd 先做有界 `fs.promises.realpath`（计入账本 key `rp:<path>`、1 s 响应期限、结果 mono 60 s 缓存），再对 realpath 结果匹配；
  未解析（超期/出错/账本满）⇒ 该路径磁盘 `unknown`（`unresolved`），不参与等级、UI 显示「—」，**绝不**以词法匹配结果冒充已验证。`/` 免解析。
- fstype 白名单：`ext2 ext3 ext4 xfs btrfs f2fs zfs bcachefs overlay tmpfs vfat exfat ntfs3`；其余（nfs*、cifs/smb3、`fuse.*`、9p、ceph、
  glusterfs、autofs、davfs…）⇒ 该路径 `skipped:"remote"`，不 statfs、不参与等级。
- 账本：任一 sysload 异步 fs 操作（realpath / statfs / top 枚举与读）每 key ≤1 在途、全局 ≤2（默认线程池 4，至少留 2 线程给 pi）；
  在途未回 ⇒ 该挂载本拍沿用连续性规则，不叠发。
- 轮转准入（三挂载公平）：每拍把待探测项（去重挂载 statfs + 到期 realpath）排成环、起点每拍 +1，空槽按环序准入、结算即补位，至全部完成或 1 s 拍期限；
  健康时每拍全覆盖，1 槽卡死时其余健康挂载仍每拍被探测，2 槽都卡死 ⇒ 不发新探测，磁盘随 stale 变 unknown。
- **响应期限 ≠ 取消**：1 s 期限只结束等待（该拍记 invalid）；底层 statfs 无法取消，仍占账本直到真正返回；返回时若 generation 已变或已超期 ⇒ 丢弃。
  账本为进程全局，跨 stop/start/`/reload` 存活，防止反复重建叠加卡死线程。

### 5.5 top 进程（按需，Major #4）

- 只在两处触发：hub `GET /api/load/top`；pi 侧「gating 变 true」与「每次拒绝且缓存 >30 s」时 fire-and-forget 刷新。拒绝文案用缓存
  （≤120 s），否则写「top 快照不可用，可用 bash 跑 `ps -eo pid,comm,%cpu,rss --sort=-%cpu | head`」并触发刷新。
- 枚举全程计账直到真正结算：`opendir("/proc")` 本身、每次 `dir.read()`、`dir.close()`、每个 per-pid `open/read/close` 都是账本操作；
  top 扫描同一时刻最多占 1 槽（另 1 槽留给 statfs），单飞 key `top` 放在进程全局账本里——扫描在所有已发操作结算前不释放，重建/`/reload` 不会并发第二次扫描。
- per-file 读取有界：`open` 后单次 `read` 进固定 4 KiB 缓冲，不用 `readFile`。期限 300 ms / 2048 pid 到点**停止发起新操作**（挂起的只等结算、结果丢弃），
  返回 `partial:true`；`opendir` 在期限或 generation 变更后才返回 ⇒ 立即 `close()`（计账）不再 read。
- 身份与单位：前次表只保留本次扫到的 pid（≤2048），以 `(pid,starttime)` 匹配；`USER_HZ`/页大小的权威获取见 §10 包注 Minor 7。
- CPU% = 单核百分比（可 >100%，同 top）：`Δ(utime+stime)/HZ/Δmono(s)×100`；无匹配前次 ⇒ 生命周期平均、标 `avg`。
- 输出：按 `comm` 聚合，byCpu / byRss 各**固定 top-5**：`{comm, count, cpuPct, rssBytes, pids[≤8]{pid,cpuPct,rssBytes}}`；只读 `comm`，绝不读 cmdline/environ。

## 6. 闸门与通知

### 6.1 settings（`LoadSettings`，`parseLoadSettings` 逐字段容错，非 live：session_start 捕获，改后 `/reload`；hub 侧改后 `/webhub restart`）

`load.enabled` true · `load.gate` true · `load.gateLevel` "crit"|"warn"(crit) · `load.sampleIntervalMs` 5000 · `load.sustainMs` 60000 ·
`load.recoverMs` 30000 · `load.cpu.{warnPercent 85, critPercent 95, psiWarnPercent 40, psiCritPercent 70}` · `load.mem.{warnAvailPercent 15, critAvailPercent 8}` ·
`load.disk.{warnFreePercent 10, critFreePercent 5, critFreeGiB 5}` · `load.hint.{enabled true, display true, repeatMs 600000, minIntervalMs 120000}` ·
`load.hud` true · `webHub.load` true。时长键进 `TIME_SETTING_MS_PATHS`。v1 删除 `extraPaths`/`topCount`/`wakeOnRecovery`。

### 6.2 准入挂点

- `SpawnRequest.loadPolicy?: "reject"`（`core/types.ts`，紧挨 `poolFullPolicy`；`request-threading.ts` 排除表登记）。只有 `createAgentTool` 的
  `prepareSpawn` 写入（`deps.loadGate?.()` 为真时）。
- 顶层：`index.ts` 的 agent-tool deps 传 `loadGate`；**嵌套**：`service/runtime-adapter.ts:≈732` 的 nested `createAgentTool({...})` 另行构造，
  须新增 `RuntimeAdapterDeps.loadGate?: () => boolean` 并由 `stack.ts` 的 `createRuntimeRunnerAdapter` 注入（v1 遗漏，Major #6）。
- `spawn-service.ts` 零副作用准入区，quota 闸门之后（≈L685）、nesting/runId/label 之前：`deps.loadGate?: (ctx:{nested:boolean}) => {message}|undefined`；
  `nested = req.parentRunId !== undefined && nesting.has(req.parentRunId)`，渲染嵌套版文案；判定只读 §5.3 有效闸门（读时强制新鲜度）。拒绝 `{kind:"config", message, retryable:true}`；
  仅**主会话**拒绝置 `rejectedSinceRecovery=true`（嵌套拒绝不武装恢复提示）。pool-full（已有）先于 load。

### 6.3 入口矩阵

| 入口                                               | 行为                    | 理由                                      |
| -------------------------------------------------- | ----------------------- | ----------------------------------------- |
| 主会话 `Agent`（含 `resume`）                      | reject                  | U1；resume 新建 run 会话                  |
| 嵌套 `Agent`（含名为 verifier 的普通 agent type）  | reject（嵌套文案）      | Q2；按入口而非 type 名判定                |
| workflow `agent()`                                 | host FIFO queue（§6.5） | U1；子请求不带 `loadPolicy`，无竞态       |
| consult fork / `/goal` 内部 verifier / `/mem tidy` | 豁免                    | 运行中 run 的同步调用或系统闭环，只读短跑 |
| `/task`、`@mention`                                | 豁免                    | 用户显式意图                              |
| RPC spawn、cron                                    | 豁免（代决 Q3）         | 程序派生 run 家族                         |

### 6.4 通知（`customType:"subagent:load"`，全部 `triggerTurn:false`）

- 阶梯：闩锁=上次播报等级；升 warn / 升 crit 各一次；crit 每 `repeatMs` 复读；`minIntervalMs` 地板（crit 与恢复绕过）；send 失败闩锁回滚。
- 恢复提示**单槽**：`provenRecovered` 且（曾播 ≥gateLevel ∨ `rejectedSinceRecovery`）⇒ 置 `pendingRecovery`；turn_end `sendMessage` **成功后**才消费并清
  `rejectedSinceRecovery`；失败保留下轮重试（槽只有一个，天然有界）；再次升到 gateLevel ⇒ 槽作废；`stop/dispose` ⇒ 清空；print/json 不启动；
  `load.hint.enabled=false` ⇒ 不置槽，拒绝文案也不承诺提示。
- 文案（首行英文紧凑 token）：

```
load gate: 系统负载过高（crit），本次派发已拒绝，未创建任何 run / label / worktree。
[load] crit · CPU 97% (PSI 74%) · MEM 6% avail · DISK / 3.1G free · since 14:02 (2m)
loadavg 18.2 / 15.1 / 9.8 (16 cores) · own runs: fix-auth, review-x (+1)
top cpu: node×3 380% · cc1plus×8 95% … ｜ top rss: java 9.8G · node×3 4.1G …
可二选一：① 排查负载来源（上列进程；bash `ps`/`top -bn1`；若是自己派出的 run 可 abort_subagent）；
② 等待回落——v1 不会自动唤醒，可先做不需派发的工作或结束本轮，回落后下一轮开头会收到 [load] 恢复提示再派发。
（settings 文件里把 load.gate 设为 false 可关闭本闸门。）
```

嵌套版第二段替换为「请不要再委派：自己完成剩余工作，或带着现状说明交回上层」。升级块：`[load] crit · … — 已暂停派发新子 agent：Agent 调用会被拒绝，
workflow 的 agent() 会排队。`；恢复块：`[load] ok · CPU 41% · MEM 38% avail · DISK / 12G free — 负载已回落，可以继续派发。`

### 6.5 workflow 等待（Major #9，如实表述）

- `ChildSpawner.loadAdmission?`（可选，缺席逐字节同今天；`blocked()` ≡ §5.3 有效闸门、读时强制新鲜度，`load.gate=false` ⇒ 恒 false 不排队）；`handleAgent` 排队条件加 `|| loadBlocked()`，`pump()` 循环加 `&& !loadBlocked()`；
  `onGateCleared(() => pump())`，`terminate`/`stopOwned` 退订；`queued` 子事件加可选 `reason:"load"|"maxParallel"`。
- 三层等待各自有界、互不替代：① host FIFO（含 load 等待）**没有单次超时**，只受 workflow `killAt`（可经 `extend_subagent_timeout wf_…` 延长）
  与不可延长的 `hardAt` 约束，到点 `stopOwned` ⇒ withheld `null`；② 派发后 core SlotPool 的 `queueWaitMs` 只从 spawn 起算；③ 子 run 自身 deadline。
- 结论：这是**有界饥饿，不是无死锁**——脚本 `await` 一个被 load 挡住的 `agent()` 时整条 workflow 停滞至负载回落或 `hardAt`；运行中 child 若依赖排队
  child 的产出（脚本层编排），同样停滞到截止。v1 **不加** load-wait 上限：裁决 U1 要求排队；上限到点也只能 withheld `null`，与 `killAt` 同结局、
  只是更早；`hardAt` 已保证终止。可见性：既有 `queueWaitMs` 记录等待时长，fleet 显示 `queued(load)`。

## 7. 协议、hub 与 UI

### 7.1 协议（additive，不升 proto）

- `messages.ts`：`LoadWire{v:1; at; intervalMs; scope:"host"; level; thresholds; cpu?; mem?; io?; disks?[≤2]{label:"~"|"/", path, usedPct, freeBytes,
totalBytes, level, skipped?}; loadavg?}`；`LoadTopWire{at; partial?; byCpu[≤5]; byRss[≤5]}`；`StatusInfo.loadGate?{gating:boolean; level; sinceAgoMs?}`（M9）。
- `http-contract.ts`：`SSE_EVENTS` 在 `"spawns"` 前插 `"load"`；`LOAD_TOP_PATH`；`ports.ts`：`HubEvent{type:"load"}`、`HubConfig.load?`；cap `load.v1`。

### 7.2 hub 侧（`src/web-hub/hub/load.ts`）

- `buildHubConfig` 仅在 `load.enabled ∧ webHub.load` 时写 `config.load`（任一为 false ⇒ 整键省略 ⇒ 无 sampler/cap/帧/路由）；hub 不承载 gate 概念，
  Pill/Card 只显示等级，绝不写「已暂停派发」。hub sampler 同样用单调 timer clock 与读时新鲜度。
- `main.ts` 用 `normalizeHubLoadConfig` 校验 `config.load`（越界/类型错 ⇒ 丢整键并 stderr，同 preview 先例）；启动探针同步读 `/proc/stat`（失败 ⇒ 无 cap）。
- 路径仅 HOME 所在 FS 与 `/`（同一 FS 去重）；不看任何会话 cwd。sampler 生命周期跟随 hub start/close，定时器 unref、不计入 idle（`hub.ts:≈1304` 的
  counts 不变）。直发：遍历 `sse.list()` 调 `client.send("load")`（`sse.ts:≈199`，无 id、不进 ring）；`openEvents` 在 `spawns` 后补发最新快照；
  数据丢失时发显式 `level:"unknown"` 替换帧；指纹去重，心跳 = 3×interval。

### 7.3 `/api/load/top`（LAN 同宽，Q5）

- 先走该 listener 的正常鉴权（token / LAN 会话），**鉴权通过前零 IO**；`X-PWH: 1` 只是 CSRF 卫生不是鉴权。两 listener 共享单飞 + 2 s 缓存；
  每主体限频（1 req/s，突发 3，复用 `hub/cmd-limit.ts` 的 token bucket——`ratelimit.ts` 是登录退避，不适用）；等待者 ≤8，超出 `E_BUSY`；整体期限 1.5 s（`E_DEADLINE`）；客户端断开即退出等待（扫描本身单飞继续）。

### 7.4 前端

- 冻结面（P0 写声明）：`ui/src/types.ts` `HubState.load?: LoadWire`、`loadTop` 状态；`transport/types.ts` `loadTop(signal?): Promise<LoadTopOutcome>`。
- `logic/state.js`：`case "load"` 覆盖写；`hello` 与 hub 帧 caps 无 `load.v1` 时清空。stale 以客户端**收帧时刻**计：>4×`intervalMs` 标 stale。
- `LoadPill.vue`（QuotaPill 后，无数据零 DOM，`title`/aria 标「Host load」）、`LoadCard.vue`（bars + 阈值刻度、loadavg、PSI、两行磁盘 `58% · 112G free`、
  top 按 comm 聚合可展开 pid、`sampled` 时间、阈值来源披露）、`FleetDrawer.vue` 横幅（读 `status.loadGate.gating`，时长并入同行小字）。
- i18n `i18n/{en,zh}/load.ts`、`styles/load.css`（`ld-` 前缀）。HUD：`hud/footer.ts` `OWN_LINE_STATUS_KEYS` 加 `"load"`，放得下与 quota 同行，否则独占一行在前。
- gzip：合入时干净 worktree 实测，超预算才提议提额（不预先承诺数字）。

## 8. 不变量

- I1 fail-open：unknown / stale / 未解析或跳过的挂载 / 非 Linux / print·json / `load.gate=false` ⇒ 不拦、不排队；invalid 样本按 §5.2 只打断序列、
  等级至多保持到 stale（3×interval），gate 与 hint 同一口径。
- I2 只拦新派发，回落不依赖派发；I3 拒绝零副作用（准入区，先于 runId/label/resumeLocks/nesting/worktree）。
- I4 零新增定时器：pi、hub 各一个 unref 节拍；恢复提示只随 turn_end。I5 IO 有界：同步 procfs ≤64 KiB；statfs/per-pid 走账本（全局 ≤2）+ 响应期限。
- I6 无新增模块级可变状态：LoadActivation 由 `activate()` 闭包持有（不学 `stack.ts:≈216` 的 `previousQuota`），stop/dispose 递增 generation 丢迟到结果；
  **唯一例外**是进程全局 IO 账本（卡死 syscall 跨 activation 存活，同 worktree-origin `Symbol.for` 先例，容量有界）。
- I7 绝不写 systemPrompt、绝不 `triggerTurn:true`。I8 关闭面逐字节同 pre-feature（无 cap / 帧 / status 字段 / HUD 键 / spawn 字段）。
- I9 hub 导入图 pi-free（boundary 测试钉住）。I10 只暴露 comm/pid 与两类挂载路径；不读 cmdline/environ。

## 9. 测试与集成闸门

- 单元：`tests/sysload/{procfs,mounts,tracker,sampler,top,gate,render,hook,activation}.test.ts`——guest 不重计、计数回绕 invalid、等号边界、
  恢复谓词（DISK 字节+百分比双恢复，含非默认 `critFreeGiB`/百分比阈值）、真实时间戳下 12×5 s 样本（跨 55 s）不升级、`sustainMs=0` 首样本升级、迁移后清窗、
  wall 回拨且无新样本 ⇒ 读时 stale 放行、unknown 重入、128 槽上限、`gate=false` ⇒ blocked/横幅/文案全关、symlink HOME/cwd 未解析 ⇒ unknown、
  分量边界匹配、三挂载 1 槽卡死仍公平覆盖、枚举计账（opendir 迟到 close、期限后不再发起、单飞跨重建）、pid 复用 starttime 不匹配。
- `tests/config/load-settings.test.ts`；`tests/service/load-gate.test.ts`（零 run/label/worktree、nested 文案、仅主会话武装、与 pool-full/quota 顺序）。
- `tests/workflow/load-queue.test.ts`：queued(load)、gateCleared pump FIFO、killAt 延长后继续等、hardAt withheld null、取消时退订、与 pool 饱和叠加、无 loadAdmission 逐字节同。
- **集成闸门（真实进程/真实接线）**：
  - `tests/integration/load-threadpool-starvation.test.ts`：照 `web-hub-history-starvation` 模式，子进程 `UV_THREADPOOL_SIZE=4` + 真 FIFO 冒充挂死 statfs，
    20 拍后断言账本 ≤2 卡死线程、同进程无关 `fs.promises.readFile` 200 ms 内完成、generation 迟到结果被丢弃；另一例让 FIFO 冒充挂死的 top 枚举读，断言扫描单飞不叠发。
  - `tests/integration/load-print-mode.test.ts`：print/json 模式不启动采样、进程按时退出。
  - `tests/integration/load-nested-agent.test.ts`：经真实 runtime-adapter 注入的嵌套 Agent 被拒且文案为嵌套版。
  - `tests/integration/load-producer-matrix.test.ts`：§6.3 每个入口（含普通 verifier type vs `/goal` 内部 verifier）reject/queue/admit 矩阵。
  - `tests/integration/load-turn-end-wiring.test.ts`：阶梯、单槽恢复、send 失败重试、unknown 不出恢复文案。
  - `tests/integration/web-hub-load.test.ts`（真 hub 子进程）：cap 矩阵、`load` 帧无 `id:`、Last-Event-ID 重连回放不含 load 且快照随后、
    `load.enabled=false` / `webHub.load=false` 各自 ⇒ 无 `config.load`、非法 `config.load` 被丢、鉴权前零 IO、限频/等待者上限、stop 后无残留定时器、idle 自退不被采样拖住。
- UI：`tests/web-hub/ui/{logic-load,load-pill,load-card,load-banner}.test.ts`（含 `sinceAgoMs` 收帧锚）；contract / i18n-parity 自动覆盖。全量：format:check → typecheck → test → build；UI 包另跑 build:web + check:web（干净 worktree）。

## 10. 包切分与独占文件域

**基线屏障**：开工前以下当前脏/未跟踪文件必须已提交（记录基线 commit），否则 P0 不得开工：`AGENTS.md`、`docs/dev/hub-resilience/plan.md`、
`src/config/setting-specs.ts`、`src/core/{deadline,state-machine,types}.ts`、`src/runtime/runner.ts`、`src/tools/{agent-tool,extend-timeout-tool}.ts`、
`src/web-hub/hub/{audit,http,hub,ports}.ts`、`src/web-hub/hub/worktree-diff/{git,membership,routes}.ts`、`src/web-hub/hub/worktree-graph/`、
`src/web-hub/ui/src/{components/detail/WorktreePanel.vue,components/graph/,composables/useWorktreeGraph.ts,i18n/en/graph.ts,styles/tokens.css}`、
`src/workflow/{deadline,orchestrator,run-budget,types}.ts` 及对应 `tests/**` 改动。

| 包                    | 独占文件域                                                                                                                                                                                                                                                                                                                                                                                                                                           | 依赖 / 并行            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **P0 冻结面**         | `src/sysload/types.ts`；`config/{settings,setting-specs}.ts` load 段；`core/types.ts` `loadPolicy`；`service/request-threading.ts` 一行；`protocol/{messages,http-contract}.ts`、`hub/ports.ts` load 类型；`ui/src/logic/contract.js`；`ui/src/types.ts`、`ui/src/transport/types.ts` 声明；`tests/config/load-settings.test.ts`                                                                                                                     | 基线后串行先行         |
| **P1 核心**           | `src/sysload/**`（除 types.ts）、`tests/sysload/**`、`tests/integration/{load-threadpool-starvation,load-print-mode}.test.ts`（+ fixtures 子目录 `fixtures/sysload/`）                                                                                                                                                                                                                                                                               | P0 后，与 P4 并行      |
| **P4 前端**           | `ui/src/components/load/**`、`ui/src/logic/load.js`、`ui/src/transport/{token,password}.ts`（`loadTop` 实现）、`ui/src/logic/{token-client,password-client}.js`（实际鉴权 fetch）、`ui/src/composables/useHub.ts`（透传）、`ui/src/types.ts` 与 `transport/types.ts`（P0 之后唯一后续改动方）、`TopBar.vue`、`drawer/FleetDrawer.vue`、`logic/state.js`（仅 load 分支）、`styles/load.css`、`i18n/{en,zh}/load.ts`、`tests/web-hub/ui/load*.test.ts` | P0 后                  |
| **P2b workflow**      | `src/workflow/{host,spawner-adapter}.ts`、`tests/workflow/load-queue.test.ts`                                                                                                                                                                                                                                                                                                                                                                        | P1 后；先于 P2a 合入   |
| **P2a pi 接线**       | `service/{spawn-service,runtime-adapter}.ts`、`tools/agent-tool.ts`、`stack.ts`、`index.ts`、`hud/footer.ts`、`commands/status.ts`（`/agent status` 摘要行）、`web-hub/agent/{index,status}.ts`、`tests/service/load-gate.test.ts`、`tests/integration/{load-nested-agent,load-producer-matrix,load-turn-end-wiring}.test.ts`                                                                                                                        | P1 + P2b 后            |
| **P3 hub**            | `web-hub/hub/load.ts`（新）、`hub/{hub,http,main}.ts`、`tests/web-hub/hub/load*.test.ts`、`tests/integration/web-hub-load.test.ts`、`tests/web-hub/boundary.test.ts`                                                                                                                                                                                                                                                                                 | P1 后，与 P2a/P2b 并行 |
| **P5 收口**（主会话） | `AGENTS.md`、`scripts/web-hub/check-ui-dist.ts`（仅实测超标时）、本文修订记录                                                                                                                                                                                                                                                                                                                                                                        | 全部后                 |

- 包注（v2 复审 Minor，不扩大 v1 范围）：
  - **P1·M7**：`USER_HZ`/页大小一次性有界读 `/proc/self/auxv` 的 `AT_CLKTCK`/`AT_PAGESZ`；读不到 ⇒ 省略 `cpuPct`/`rssBytes`（n/a）不猜；生命周期平均 elapsed = `uptime − starttime/HZ`；聚合行保留 `avg`。
  - **P1·M8**：invalid 统一按 §8 I1；分类前拒绝非有限值、零分母（`MemTotal=0`、`blocks=0`、`blocks−bfree+bavail≤0`）与不可能关系（`avail>total`、`bavail>blocks`、`bfree<bavail`）。
  - **P0·M9**：wire 不下发 mono `since`，`LoadWire`/`StatusInfo.loadGate` 改 `sinceAgoMs`（投影时 elapsed）+ `at`；浏览器以收帧时刻为锚累加（P1 投影、P4 渲染）。
  - **P3·M10a**：`/api/load/top` 限频用 `cmd-limit.ts` bucket（键 `${listener}:${principal}:load-top`）；**P4·M10b**：logic clients 已入 P4 域。
- 热点规则：上表外的共享文件（barrel、其余 i18n、其余 workflow/hub 文件）一律冻结，越界必须停下上报；派单前跑 `conflict-check.mjs`；commit 前缀 `[sysload:Pn]`，精确路径提交。
- 车道 L3：P0 评审通过才放行 P1/P4；每包验收模型 ≠ 开发模型。

## 11. 关键接线速查

- `index.ts` activate()：`const load = createLoadActivation({mono, clock: createSegmentedClock({now: mono, set: unrefSetTimeout}), settings: settings.load})`；session_start（非 print/json）`load.start(ctx)`，
  session_shutdown `load.dispose()`；`pi.on("turn_end", createLoadHintHook({ port: () => load.port(), ... }))`；buildSessionStack 新增可选参数 `ports.load`。
- `stack.ts`：`createSpawnService({loadGate})`、`createRuntimeRunnerAdapter({loadGate})`、`createWorkflowChildSpawner(..., {loadAdmission})`、HUD `setStatus("load")` 均读 `ports.load`；
  不新增 `let previousLoad`。`web-hub/agent`：`status.loadGate` getter + `buildHubConfig` 写 `load`（`load.enabled=false` 或 `webHub.load=false` ⇒ 不写）。

## 12. 风险

- R1 容器内 `/proc` 反映宿主（cgroup 延后）；R2 长构建持续打满会真实拦派发（设计意图）；R3 白名单外本地 FS / 未解析 symlink ⇒ 磁盘 unknown；R4 卡死的 fs 线程不可回收（≤2，账本保证不增长）；
- R5 小盘 `≤ critFreeGiB` 常驻 crit ⇒ 文案点明 DISK 触发、可调；R6 hub 与会话阈值/路径不同 ⇒ Pill 与横幅可能长期不一致（已标注视角与来源）；R7 基线屏障拖延开工；R8 gzip 余量。

## 13. 待决问题与裁定记录

- 无阻塞项（v2 观察：cgroup v2；cron「crit 跳过 + 日志」；白名单设置项）。裁定：2026-10-10 第一轮：U1–U5（§2）。第二轮：Q1 不唤醒、Q2 嵌套拒绝、Q5 LAN 同宽、视觉稿三微调、Q3/Q4/Q6/Q7 主会话代决（§2）。

## 14. 评审处置表（r_CTJP0TPV，16 条）

| #   | 级别    | 问题摘要                                                                | 处置                          | 落点                                                                                      |
| --- | ------- | ----------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | blocker | withDeadline 不取消 IO、statfs 挂死占线程池、发现无界、账本随重建丢失   | 接受                          | §5.4（白名单跳过远程、mountinfo 有界、进程全局账本、期限≠取消、迟到丢弃）、§9 饥饿门      |
| 2   | blocker | 迟滞方向对 available/free 错误；磁盘 OR 触发恢复不完整                  | 接受                          | §5.2 逐指标升/恢复谓词、等号语义、迁移后新窗口                                            |
| 3   | major   | CPU guest/iowait/回绕、内存单位、bfree/bavail、GB/GiB 未冻结            | 接受                          | §5.1；`critFreeGiB` 改名                                                                  |
| 4   | major   | 拒绝路径需 top 但无刷新定义；枚举无界；HZ/页大小/pid 复用               | 接受                          | §5.5（按需触发 + 过期回退、增量枚举、`(pid,starttime)`、动态单位、单核语义）              |
| 5   | major   | Date.now 跳变；设置可致巨环；unknown/换挂载连续性不明                   | 接受                          | §5.2 单调时钟、范围与 128 槽上限、连续性规则                                              |
| 6   | major   | 嵌套 Agent 在 runtime-adapter 另行构造，漏接；文案无 request            | 接受                          | §6.2（`RuntimeAdapterDeps.loadGate`、`nested` ctx、仅主会话武装）；归 P2a                 |
| 7   | major   | crit→unknown 被当恢复                                                   | 接受（因 Q1 简化）            | §5.3 `gateCleared` vs `provenRecovered`                                                   |
| 8   | major   | 发送失败丢计数、模式/开关与承诺不一致                                   | 接受（因 Q1 简化）            | §6.4 单槽、发送成功才消费、dispose 清空、print/json 不启动、hint 关则不承诺               |
| 9   | major   | host FIFO 无单次超时、queueWaitMs 派发后才起算、killAt 可延长、依赖停滞 | 接受，**不加** load-wait 上限 | §6.5 三层等待如实表述，「有界饥饿非无死锁」+ 理由                                         |
| 10  | major   | hub cwd=HOME、singleton 保留首启配置 ⇒ 磁盘/阈值长期不一致              | 接受                          | §3/§7.2 主机全局（HOME FS + /）、UI 标注视角、披露配置来源，不承诺一致                    |
| 11  | major   | 包域漏 HubState/transport/useHub；脏文件未设屏障                        | 接受                          | §7.4 冻结面、§10 P4 独占 + 基线屏障清单；P2b→P2a 合并顺序保留                             |
| 12  | major   | LAN 暴露未决、X-PWH 非鉴权、限频与 config 校验缺失                      | 接受（Q5 已裁同宽）           | §7.3 鉴权先于 IO、单飞/缓存/限频/等待者/断开期限；§7.2 `normalizeHubLoadConfig`、有界探针 |
| 13  | minor   | hello 后旧数据残留；wire 缺阈值；固定 15 s 新鲜度                       | 接受                          | §7.4 hello/无 cap 清空、显式 unknown 帧、wire 带 `thresholds`/`intervalMs`、新鲜度随节拍  |
| 14  | minor   | `previousLoad` 模块级状态违背 I6                                        | 接受                          | §8 I6、§11：activation 闭包持有；唯一例外 IO 账本（理由已写）                             |
| 15  | major   | 只有假 IO 测试，缺真实集成门                                            | 接受                          | §9 六个集成闸门（饥饿、print、嵌套注入、入口矩阵、Last-Event-ID、singleton/idle）         |
| 16  | minor   | extraPaths/topCount/计数/预提额扩大契约                                 | 接受                          | §1/§6.1/§7.4：固定 top-5、三路径、单恢复槽、gating 布尔、实测后再议预算                   |

## 15. v2.1 处置（r_CTJP0TPV 复审，conditional_pass）

| #   | 级别  | 处置                                                                                                                          | 落点                            |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Major | 接受：时长以 `last.mono−first.mono` 证明 + 不间断合格序列；`sustainMs=0` 首样本                                               | §5.2、§9                        |
| 2   | Major | 接受：磁盘恢复用 `G_crit+mDISKB`，全部符号绑定有效 settings                                                                   | §5.2、§9                        |
| 3   | Major | 接受：有效闸门 `enabled ∧ gate ∧ known≥gateLevel` 单点计算全链路共用；hub 配置在 `load.enabled`/`webHub.load` 任一关闭时省略  | §5.3、§6.2、§6.5、§7.2、§8、§11 |
| 4   | Major | 接受：单调 timer clock 调度采样与期限；`verdict()`/`blocked()` 读时强制新鲜度                                                 | §5.2、§7.2、§11、§9             |
| 5   | Major | 接受：HOME/cwd 有界 realpath，未解析 ⇒ unknown 不冒充已验证；分量边界匹配；轮转准入保三挂载公平                               | §5.4、§9                        |
| 6   | Major | 接受：枚举 opendir/read/close 与 per-pid 读全部计账至结算，迟到 open 即 close，单次 4 KiB 读，期限后停发，单飞 key 在全局账本 | §5.5、§9                        |
| 7   | Minor | 接受，归 P1（auxv 权威单位，读不到省略）                                                                                      | §10 包注                        |
| 8   | Minor | 接受，归 P1（invalid 统一口径 + 异常关系拒绝）                                                                                | §8 I1、§10 包注                 |
| 9   | Minor | 接受，归 P0（`sinceAgoMs` + 收帧锚）                                                                                          | §10 包注                        |
| 10  | Minor | 接受，拆 P3（cmd-limit bucket）与 P4（logic clients 入域）                                                                    | §7.3、§10                       |

## 16. 实施记录（P5 收口，2026-10-11）

- 提交：P0 `1a93950`、P4 `bb6db5c`、P1 `e9c09c8`、P2b `65ea6b3`、P3 `326794d` + 测试 `2aea630`、P2a `f2a5fa5`、修复包 `7436b1c`。
- 实施期裁定（主会话）：`LoadTopRowWire.cpuPct/rssBytes` 改为可选（缺失 ⇔ n/a，取代 NaN 哨兵）；`MetricState.levelSinceMono` / `LoadVerdict.gatingSinceMono` 追加为可选字段（稳态闸门时长）；`parseLoadSettings` 越界值钳到边界（§6.1 「逐字段容错」的实现口径）。
- 与本文不一致处（按冻结类型实现）：磁盘只采两条路径（无 cwd 第三路径）；MEM PSI 未采集（wire 无字段）；hub Card 不显示 PSI-mem/Swap/MEM 绝对 GiB（wire 无字段）。
- UI JS gzip 预算按实测上调为 255 KiB（`scripts/web-hub/check-ui-dist.ts`）；CSS 25,273 B / 25 KiB，余量约 330 B。
