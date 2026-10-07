# web-hub 受管会话跨 hub 重启恢复（spawn restore）— 设计与施工方案 v1

> 上游契约：`docs/dev/web-hub-spawn/arch.md`（v2，下称 arch；重点 §4.2、§7.2–§7.7）、`docs/dev/web-hub-spawn/plan.md`（plan v2，下称 spawn-plan；§3.1 状态机、SP5/SP7/SP13）、
> `docs/dev/web-hub-delete-session/plan.md`（v2，下称 delete-plan；B-alive / B-fork / B-stream 三条底线、`removeIntent`）。
> 代码坐标以 `547635d`（master HEAD）为准，并附符号名；pi 源码坐标相对 `~/.nvm/versions/node/v22.22.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/`（**1.0.2**，arch 写的 0.87 已过时）。
> 本文只做设计，不改 `src/`。施工前按符号名重核行号。

## 0. 结论速览

| 议题        | 结论                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技术路径    | **不做活收养**。旧进程一律先经身份核验后结束（EOF / SIGTERM / SIGKILL），确认死亡后由新 hub 用持久化的会话坐标重新 fork：`pi --mode rpc --session <sessionFile 绝对路径>`（文件尚未落盘时退化为 `--session-id <sessionId>`）。进行中那一轮输出丢失，会话历史保留                                                    |
| 恢复范围    | 「hub 停止时处于 live/starting 的记录」落实为：**非终态且持久化了合法 `sessionId`**，并且 `state==="live"`，或 `stopping` 且带 `restoreIntent`（优雅 restart 打的标），或 `starting` 且带 `restore.phase`（上一轮恢复做到一半）。从未 live 的新建 `starting`/`launching` 记录没有会话可恢复，保持现有回收行为（D3） |
| 触发路径    | 优雅：`close(reason)` 的 reason ∈ {`restart`, `superseded`, `crash`} ⇒ `supervisor.shutdown(d, {mode:"restore"})`；`stop`/`signal`/`fence`/`idle` ⇒ 现有 terminate。崩溃（SIGKILL/OOM）：无关停机会，boot 时按上面的候选规则识别                                                                                    |
| spawnId     | **复用**（卡片 / SpawnRow / 审计连续）；agentKey 必然变化，旧 key 在确认旧进程死亡后由 `registry.remove(prevKey,{allowConnected:true})` 清掉，Public 投影带 `restore.prevAgentKey` 让 UI 把详情页切到新卡片                                                                                                         |
| 状态机      | 不新增 `SpawnState`；恢复中的记录 wire 上是 `starting`，附加可选 `restore:{phase, attempt, failure?, prevAgentKey?}`。所有**持久化枚举**（`state`/`endReason`/`hint`）保持现有取值集合（回滚安全，D11）                                                                                                             |
| 时限        | 注册期限从 **fork 时刻** 起算（`2×registerTimeoutS`，上限 240s）；运行时限**仍以原 `createdAt` 为锚**（恢复不延寿也不缩寿），剩余 <5min 不恢复；连续恢复上限 3 次，live 稳定 2min 清零                                                                                                                              |
| 孤儿契约    | L1–L5 全部保持（逐条见 §7）；新增 **L6 单会话单进程**：旧身份未被确认死亡（`computeDeath==="confirmed"`）之前绝不 fork 恢复进程。reaper 不感知 restore                                                                                                                                                              |
| 删除 / stop | `removeIntent` 绝对优先于 restore；`/webhub stop` 绝不 restore（ctl `reason:"stop"` 精确识别 + 一次性 `restore.veto` 文件兜住「hub 卡死走 SIGTERM 回退」的缝）                                                                                                                                                      |
| 设置        | `webHub.spawn.restore`，**默认 `true`**（只在已显式开启的 `webHub.spawn.enabled` 之下生效）；为 `false` 时 spawns.json、关停、boot 行为与现状逐字节一致                                                                                                                                                             |
| 新硬门槛    | HR1–HR7（integration）+ CR1–CR3（conformance，真实 pi `--session`/`--session-id`）                                                                                                                                                                                                                                  |

---

## 1. 需求与范围

### 1.1 用户拍板（不得更改）

1. web-hub 重启后应恢复由 webhub 启动（managed spawn）的 pi 进程与会话。覆盖两条路径：`/webhub restart` 优雅重启、hub 崩溃后被重新拉起。
2. 恢复范围：**hub 停止时处于 live/starting 的记录**；已 terminal 的不自动复活。
3. 技术路径（取证后定）：身份验证后结束旧进程 → 等退出 → 用持久化的会话坐标以 `pi --mode rpc --session …` 重新 fork。进行中那轮输出丢失，会话历史保留。

### 1.2 范围的精确化（本文的落实口径）

「live/starting」在代码里要落成可判定的谓词。约束有两条：

- **要有会话可恢复**。没有会话坐标就无从 `--session`。新建记录在 `goLive()` 之前没有 `sessionId`（`supervisor.ts:1128-1145`），而 pi 的会话文件要到出现第一条 user/assistant 消息才落盘（`core/session-manager.js:786-792`）。从未 live 的 `starting` 里既没有对话也没有首条消息（首条消息只在 live 之后投递，且正文从不落盘，arch §4.6），没有可恢复的内容。
- **不能把「用户 / 系统明确要求结束」的记录复活**。`stopping{user|lifetime|protocol_error|…}`、`/webhub stop` 留下的 `stopping{hub}` / `exited{hub}` 都不复活。

由此得到唯一的候选谓词（§6.4 表给出逐状态展开）：

```
restore 候选 ⇔ cfg.restore ∧ ¬veto ∧ ¬bootChanged ∧ ¬removeIntent ∧ validSessionId(sessionId)
             ∧ ( state==="live"
               ∨ (state==="stopping" ∧ restoreIntent===true)        // 优雅 restart 时被打标（含已退出被「停放」的）
               ∨ (state==="starting" ∧ restore.phase !== undefined)) // 恢复进行到一半时 hub 又停了
```

因此「starting」在本需求里指的是**正在恢复中的 starting**（它带着上一轮持久化的 `sessionId`）；全新的 starting 走现有行为。把全新 starting 改成「不带 `--session` 原样重拉一个空会话」作为备选列在 D3，未采纳，并列入 §14 待确认。

### 1.3 非目标

- 活收养（保留旧进程并重新接管，§3.1 排除）。
- 机器重启后恢复（`bootId` 变化 ⇒ 现有 `boot-changed` 行为，不恢复）。
- 首条消息跨重启重放（正文从不落盘，arch §6.4 不变；未送达 ⇒ 现有 `expired{hub_restart}`）。
- 进行中那一轮的输出续传。
- 非 Linux（spawn 本身 fail closed，arch §7.1）。

---

## 2. 现状取证（文件:行号 @547635d）

| #   | 事实                                                                                                                                                                                                                                                                                                 | 坐标                                                                                | 对本设计的意义                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 优雅关停：每个非终态记录先置 `stopping{hub}`（已在 stopping 的保留原因）→ `stdin.end()` → 等 `deriveBudget(r,3000,6500)`（正常 close 下 = 3000ms）→ 存活者**身份核验后** SIGTERM（KILL 留给 reaper）→ `store.flushAndClose` → 关 stderr → `reaper.close()`                                           | `supervisor.ts:1751-1797`（`shutdown`）；`req-deadline.ts:57-59`（`deriveBudget`）  | 不区分 reason；restore 需要在这里分叉，但**梯度不变**                                                                                |
| F2  | 关停窗口内退出的孩子走 `onChildExit → finalizeTerminal`，落成 `exited{hub}` 终态并 `reaper.untrack`                                                                                                                                                                                                  | `supervisor.ts:1097-1115`、`:926-966`                                               | restore 模式下要「停放」而不是终态化（D5），否则终态记录既会被 trim，又与「终态不复活」冲突                                          |
| F3  | hub `close(reason)`：先 `firstPromptFwd.dispose("hub_restart")`，再 `await spawnSup.shutdown(deadline)`；reason 已是字符串一路传到这里                                                                                                                                                               | `hub.ts:1050-1105`（`spawnSup.shutdown` 在 `:1077`）                                | reason→mode 的映射只需在 `:1077` 一处完成                                                                                            |
| F4  | close 的调用方与 reason：admin `shutdown(reason)`→`close(reason)`（`"restart"`/`"stop"`）、supersede `close("superseded")`、SIGTERM/SIGINT `close("signal")`、uncaughtException `close("crash",{deadline:2.5s})`、socket fence `close("fence")`、idle `close("idle")`                                | `hub.ts:284-296`、`:813`、`:1031`、`:1046`、`:1135-1150`                            | restore 原因集合可以完全在 hub.ts 内定义，admin/agent-server 不用改                                                                  |
| F5  | admin 层 `handleShutdown(meta, reason: "restart" \| "stop")`，agent-server 收到 `hub_ctl{op:"shutdown"}` 先 ack 再调用                                                                                                                                                                               | `admin.ts:54`、`:245-248`；`agent-server.ts:204-222`；协议 `messages.ts:562`        | reason 已经区分                                                                                                                      |
| F6  | `/webhub restart`：hub 在线且有 `ctl.v1` ⇒ `hub_ctl{shutdown, reason:"restart"}` → 等 ack ≤2s → 等 pid 退出 ≤5s → `spawn()`；否则回退：经 hub.json 身份核验后 **SIGTERM**                                                                                                                            | `agent/restart.ts:141-160`、`:102-126`                                              | 回退路径到 hub 侧是 `close("signal")`，与「外部 kill」不可区分（§8.3）                                                               |
| F7  | `/webhub stop`：先写 stop marker，hub 有 `ctl.v2` ⇒ `reason:"stop"`，只有 `ctl.v1` ⇒ `reason:"restart"`；回退同样是 SIGTERM。新 hub 恒带 `ctl.v2`（`P2_HUB_CAPS`）                                                                                                                                   | `agent/restart.ts:163-195`；`agent/admin-cmds.ts:166-200`；`protocol/version.ts:20` | stop 精确可辨；回退缝用 veto 文件兜住（D13）                                                                                         |
| F8  | boot recovery：非终态记录 `bootChanged` ⇒ `noProcess:"boot-changed"` + `finalizeRecovered(boot-mismatch)`；有完整身份 ⇒ `finalizeRecovered` + `recoverEscalate`（`setImmediate` 内同步 verify→SIGTERM，+3s verify→SIGKILL）；`launching` ⇒ environ 扫描（下界 `createdAt-1s`）；其余 ⇒ 无信号 orphan | `supervisor.ts:1625-1682`、`:1518-1555`、`:1575-1622`                               | restore 候选在这里分流；environ 扫描的下界在 spawnId 复用后必须改成 `forkIntentAt`（§7 L1）                                          |
| F9  | `removeIntent` 的 boot 收敛：终态记录逐条 `computeDeath`，未确认的延迟 `RECOVER_KILL_AFTER_MS + EXIT_GUARD_MS` 再判                                                                                                                                                                                  | `supervisor.ts:1684-1716`                                                           | removeIntent 记录不进 restore（D12）                                                                                                 |
| F10 | `goLive()` 只在内存上记 `rec.sessionId`，`persistDebounced()`；`toStored()` 不写 `sessionId`；`StoredRecord` 无会话字段                                                                                                                                                                              | `supervisor.ts:1128-1145`、`:544-573`；`store.ts:102-146`                           | 需要新增持久化字段并同步落盘（D6）                                                                                                   |
| F11 | `session` 总线事件只在 `rec.state==="starting"` 时被消费（触发 goLive）；live 之后会话切换（网页 `/new`、`switch_session`）不更新记录                                                                                                                                                                | `supervisor.ts:1191-1195`                                                           | 要跟踪 live 期间的会话切换，否则恢复的是旧会话                                                                                       |
| F12 | `SessionInfo` 帧带 `sessionId` 与可选 `sessionFile`（agent 侧 `agent/index.ts:1183` 填写）                                                                                                                                                                                                           | `protocol/messages.ts:90-96`                                                        | 会话文件绝对路径可直接拿到                                                                                                           |
| F13 | store 形状校验：**任何一个字段违规 ⇒ 整个文件判 corrupt**（改名 `.corrupt-*`，记录全丢）；`endReason`/`hint` 用固定集合校验；未知字段放行                                                                                                                                                            | `store.ts:220-312`（`isRecordShapeOk`）、`:44-67`（`END_REASONS`/`HINTS`）          | 新增**持久化枚举值**会让回滚后的旧 hub 把整个文件判 corrupt，丢掉所有存活孩子的身份 ⇒ L4 失效。只能加新**字段**，不能扩旧枚举（D11） |
| F14 | `SPAWNS_FILE_VERSION = 2`，`v` 不等即 corrupt；写目标 64 KiB（只裁终态，裁不动也照写并标 oversize），读上限 256 KiB；非终态上限 16、终态 20                                                                                                                                                          | `store.ts:151-155`、`:352-366`（`trimRecordsForWrite`）                             | 不 bump 版本（D11）；预算核对见 §5.3                                                                                                 |
| F15 | fork 参数装配：`[launcher[1], "--mode", "rpc"]` + 可选 `["--model", m]`，env 剥 `PI_WEBHUB_*` 后注入 `HEADLESS`/`SPAWN_ID`/`PWD`；cwd 走 `pinSync` 的 `/proc/self/fd/N`；注册期限 `t0 + registerTimeoutS*1000`（`t0 = createdAt`）                                                                   | `supervisor.ts:1356-1420`（argv 在 `:1374`）、`:1475`                               | 恢复复用同一段（抽成 `forkInto`），argv 尾部换成会话参数，注册期限改为从 fork 时刻起算                                               |
| F16 | `revive()`：恢复记录 `breakerExempt:true`；`everLive` 只对 live/stopping 为真                                                                                                                                                                                                                        | `supervisor.ts:1485-1516`                                                           | 恢复失败天然不计熔断                                                                                                                 |
| F17 | 死亡判定 `computeDeath`：`pid` 缺失看 `noProcess` 证据；真实 exit ⇒ confirmed；否则 `/proc` 只读探针（ENOENT/ESRCH/starttime 不符/Z/X/uid 不符 ⇒ confirmed）                                                                                                                                         | `supervisor.ts:803-852`                                                             | L6 的判据直接复用                                                                                                                    |
| F18 | 信号路径统一 `verifyIdentityById`（platform → bootId → starttime →（组杀）pgrp → uid），核验与 `kill` 在同一同步段                                                                                                                                                                                   | `supervisor.ts:738-764`、`:766-775`                                                 | 恢复期每次发信号都走它（L5）                                                                                                         |
| F19 | reaper：stdin EOF 后等 `REAPER_GRACE_MS=5s` → 核验后 TERM → +3s 核验后 KILL → 退出；`ORPHAN_BOUND_MS=12s`                                                                                                                                                                                            | `reaper-source.ts:17`、`:188-202`；`protocol/spawn.ts:378-386`                      | 与新 hub 的恢复梯度会「双打」，§6.6 做时序分析                                                                                       |
| F20 | agent 侧连接有完整重连状态机（指数退避，`backoffMinMs·2^n` 封顶 `backoffMaxMs`，带抖动）；registry 对同一 `agentId` 重连保留 agentKey                                                                                                                                                                | `agent/connection.ts:228`、`:786-789`；`hub/registry.ts:7-10`                       | hub 重启后**还活着的旧孩子会短暂重连**新 hub 并出卡片（§6.6、§9）                                                                    |
| F21 | pi `--session <arg>`：含 `/` 或以 `.jsonl` 结尾 ⇒ 按路径直接打开；否则按 id 先本项目精确、再前缀、再**全局**匹配；全局命中时用 readline 在 **stdin/stdout** 上问 `Fork this session into current directory? [y/N]`                                                                                   | `main.js:192-216`、`:308-327`                                                       | rpc 模式下 stdin/stdout 属于 hub，这个提问会把孩子挂住到注册超时 ⇒ **只用绝对路径**（D7）                                            |
| F22 | `SessionManager.open(path)` 对**不存在的路径不报错**，直接以该路径建空会话                                                                                                                                                                                                                           | `core/session-manager.js:1326-1348`                                                 | hub 必须在 fork 前自己核验会话文件存在（§6.5 preflight），否则「会话文件被删」会被静默恢复成空会话                                   |
| F23 | `--session-id <id>`：只做本项目精确查找，命中即打开，未命中**以该 id 新建**（只往 stderr 打警告，不提问）                                                                                                                                                                                            | `main.js:245-257`、`:344-351`                                                       | 会话文件还没落盘时的安全退化（D7）                                                                                                   |
| F24 | 有历史的会话在未传 `--model` 时从会话分支恢复模型                                                                                                                                                                                                                                                    | `core/sdk.js:84-100`                                                                | 恢复**不传** `--model`，否则会覆盖用户在会话里切换过的模型（D8）                                                                     |
| F25 | 首条消息转发器对未知 spawnId 的 `onLive` 直接返回                                                                                                                                                                                                                                                    | `first-prompt.ts:292-294`                                                           | 恢复记录 live 不会误投首条消息                                                                                                       |
| F26 | stdio 只属于 fork 它的 hub 进程：`extension_ui_request` 应答、stdout 排水、EOF 有序退出杠杆                                                                                                                                                                                                          | `rpc-stdio.ts`；arch §4.4；`rpc-mode.js` 的 `waitForRawStdoutBackpressure`          | 活收养不可行的根因（§3.1）                                                                                                           |

---

## 3. 技术路径与排除方案

### 3.1 活收养（保留旧进程、新 hub 重新接管）为何被排除

活收养看上去最省事：孩子的 pi-toolkit agent client 会自己重连新 hub（F20），cmd 控制面走 socket 而不走 stdio（`registry.request(agentKey, …)`，`cmd.v1`），网页照样能 prompt / abort / command。但 hub 与孩子之间还有三样东西**只能经由 stdio 传递**，而 stdio 的另一端绑定在旧 hub 进程上，旧 hub 一死它们就没了，新 hub 也接不回来（node 不能跨进程转交 fd，arch D4）：

| #   | stdio 承担的职能                                                                                                               | 旧 hub 死后的后果                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **`extension_ui_request` 应答**：其他扩展的 select/confirm/input/editor 由 hub 自动取消，ask_user marker 有界挂起（arch §4.4） | 没有人应答。任何扩展只要弹一次对话框，那一轮就永久挂住，正是零 hang 不变量要消灭的情况                                                                                                                                                            |
| S2  | **stdout 排水**：pi 的 rpc 模式把所有会话事件写到 stdout，并且按背压等待（`waitForRawStdoutBackpressure`）                     | 管道读端随旧 hub 关闭：要么 pi 收到 EPIPE/SIGPIPE，要么（读端仍被某个进程持有时）64 KiB 管道写满后 pi 卡在背压等待。两种结果都是孩子不可用                                                                                                        |
| S3  | **EOF 有序退出杠杆**：`stdin.end()` 是停止梯的第 0 级，也是 L3 的第一层防线                                                    | 旧 hub 一死，内核就关闭管道写端，孩子立刻收到 EOF 并**自行开始有序关停**（`rpc-mode.js:641-644`），这正是 L3 有意为之的设计。也就是说，活收养要对抗的是系统自己的孤儿防线：要活收养，必须先拆掉 L3 第一层，而且新 hub 也永远拿不回停止梯的第 0 级 |

S3 实际上是决定性的：活收养不是「可靠性差一些」，而是与 L3 直接矛盾。再加上独立 reaper 会在 hub 死亡 ≤12s 内对孤儿 TERM→KILL（F19），活收养还得让 reaper「认得」新 hub 并转交看守，这会把 L2/L3 的简单契约（reaper 只认 stdin EOF）变成跨进程协商。结论：**排除**。

### 3.2 其他被排除的方案

| 方案                                                     | 排除理由                                                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reaper 在 hub 死后接管 stdio（持有 fd，充当临时 hub）    | reaper 从未持有孩子的管道（它是 hub 的另一个孩子，`stdio:["pipe","pipe","ignore"]` 只连 hub）。要它持有，就得在 fork 时把三根管道同时交给 reaper，等于再写一个 hub 的 stdio 层；还要和新 hub 交接。复杂度远超收益 |
| 把孩子放进 tmux / pty 包装器常驻（arch §3.1 方案 C）     | 外部依赖、拿不到 exit 事件、TUI 渲染开销，arch 已否决，理由不变                                                                                                                                                   |
| 关停时不结束孩子，等新 hub 起来后再判断                  | 违反 L3（hub 永不重启时孤儿永生），而且 S1/S2 照样存在                                                                                                                                                            |
| 用 `--continue`（打开本 cwd 最近的会话）代替显式会话坐标 | 同一 cwd 可能有多个会话（终端里也可能开着），「最近」不等于「这一个」                                                                                                                                             |
| 用 `--session <sessionId>`（id 形式）                    | F21：本项目找不到时会走全局匹配，在 rpc 模式下用 readline 提问，挂住孩子；前缀匹配还可能命中别的会话                                                                                                              |
| `--fork <file>`                                          | 会生成新的会话 id 和新文件，历史虽在，但会话身份断开（cmd 的 `expect.sessionId`、终端里的 resume 都对不上）                                                                                                       |

### 3.3 选定路径

```
旧进程（身份核验后）EOF / SIGTERM / SIGKILL ──▶ computeDeath === "confirmed" ──▶ preflight 会话文件 ──▶
  fork: pi --mode rpc --session <sessionFile>（文件存在）
      | pi --mode rpc --session-id <sessionId>（文件尚未落盘、且从未见它落盘过）
  ──▶ 现有链路：扩展重连 hub → agent_up(pid 匹配 ∧ cwd 匹配) → session → goLive
```

---

## 4. 设计决策

| #   | 决策                                                                                                                                                                                                                             | 备选                                                                  | 理由 / 为什么不选备选                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **杀旧 + 重 fork**，不活收养                                                                                                                                                                                                     | 活收养                                                                | §3.1：stdio 三损失，且与 L3 第一层直接矛盾                                                                                                                                                                                                                                                                                                                                                    |
| D2  | 优雅路径的 restore 原因集合 `RESTORE_REASONS = {"restart","superseded","crash"}`；`stop`/`signal`/`fence`/`idle` 走 terminate                                                                                                    | ① 只认 `restart`；② `signal` 也恢复                                   | `restart` 是用户明说的路径；`crash`（uncaughtException）属于用户说的「崩溃」路径，只是恰好还有 2.5s 可以打标；`superseded` 是插件升级引发的自动重启，不恢复就意味着每次升级都杀掉网页会话，体验与 restart 等价（**列入 §14 待确认**）。`signal` 无法区分「restart 回退」与「用户 kill / 登出」，保守不恢复；`fence` 是输掉 socket 的重复 hub；`idle` 在有孩子时不会发生（`hub.ts:1040-1044`） |
| D3  | 恢复候选只认「有 `sessionId` 的非终态」（§1.2 谓词）；全新 `starting`/`launching` 保持现有回收                                                                                                                                   | 全新 `starting` 不带 `--session` 原样重拉（同 cwd、同 model、空会话） | 从未 live 的记录没有对话，首条消息也无法重投（正文不落盘）。重拉出来的是一个用户没提交过任何内容的空 pi，价值低，而且会和用户当时「失败 / 超时」的直觉冲突。代价只是用户重新点一次。保留为待确认项                                                                                                                                                                                            |
| D4  | 优雅 restore 关停：`shutdown(deadline, {mode:"restore"})` **先给合格记录打 `restoreIntent` 并同步 `saveNow`**，再走与现状完全相同的 EOF → 等待 → 核验后 SIGTERM 梯度                                                             | 不打标，boot 时按「非终态即恢复」推断                                 | 优雅关停后孩子大多已退出，记录会被 F2 终态化，靠推断就丢了；`saveNow` 先于 EOF，是 `removeIntent` 同款纪律（delete-plan §2.2：意图先落盘再改状态）                                                                                                                                                                                                                                            |
| D5  | restore 模式下关停窗口内退出的孩子被**停放**：只记 `exit`、`reaper.untrack`、清 handles，**状态保持 `stopping`**，不进终态、不触发 `onTerminal`/trim/熔断                                                                        | 照常终态化为 `exited{hub}` + `restoreIntent`                          | 终态记录会被 `trimTerminalRecords`（20 条）和 64 KiB 裁剪淘汰，且与「终态不复活」的口径冲突。保持非终态 ⇒ 受非终态上限 16 保护（≥ `maxProcesses`），boot 规则也只需看非终态。`exit` 已记录，`computeDeath` 直接判 confirmed                                                                                                                                                                   |
| D6  | 新增持久化字段 `sessionId`、`sessionFile`、`sessionPersisted`、`restoreIntent`、`restore`；`goLive` 和 live 期间的会话切换用 `saveNow` **同步**落盘（仅 `cfg.restore` 为真时写这些字段）                                         | `persistDebounced`                                                    | 崩溃路径没有关停机会，200ms 防抖窗口内崩溃就丢坐标（会退化为杀孤儿，安全但没恢复）。goLive/切会话频率极低，同步写 ≤64 KiB 的代价可忽略。restore 关闭时不写 ⇒ 文件与现状逐字节一致                                                                                                                                                                                                             |
| D7  | 恢复 argv 尾部：会话文件存在 ⇒ `["--session", sessionFile]`（绝对路径）；不存在且 `sessionPersisted` 不为真 ⇒ `["--session-id", sessionId]`；不存在但 `sessionPersisted` 为真 ⇒ **不 fork**，`restore.failure:"session-missing"` | 一律 `--session <id>`；一律 `--session-id`                            | F21：id 形式会走全局匹配并在 stdio 上提问；F22：路径形式对缺失文件静默建空会话，所以 hub 必须先 preflight；F23：`--session-id` 是「文件还没落盘」（会话里从未有过消息，pi 懒创建会话文件，`core/session-manager.js:786-792`）的正确退化，不提问。「曾经落过盘、现在没了」就是用户删了文件，按用户期望给失败终态                                                                               |
| D8  | 恢复**不传** `--model`；`model` 字段只作展示保留                                                                                                                                                                                 | 沿用记录里的 `--model`                                                | F24：pi 会从会话分支恢复模型；传 `--model` 会把用户在会话里切过的模型冲掉                                                                                                                                                                                                                                                                                                                     |
| D9  | **复用 spawnId**；agentKey 换新；旧 key 在确认旧进程死亡后经新 dep `onPrevAgentGone` → `registry.remove(prevKey,{allowConnected:true})`                                                                                          | 新建 spawnId                                                          | 复用让 SpawnRow / 审计 / owner 归属 / LRU 外的引用全部连续；agentKey 由 agent 进程决定（F20），换新不可避免。`allowConnected:true` 只在死亡确认之后调用，与 delete-plan §2.2 的 `onRemoved` 同一安全口径。`SpawnRegistryPort` 不扩展（其 keyof 被 `types.test-d.ts` 钉住）                                                                                                                    |
| D10 | 不新增 `SpawnState`；恢复中 wire 上是 `starting`，并附加 `SpawnRecordPublic.restore`                                                                                                                                             | 新状态 `restoring`                                                    | 新状态要改协议联合类型、`isTerminalSpawnState`、所有计数与 UI 分支，还会撞上 F13 的持久化枚举问题。`starting` 的既有语义（占启动名额、显示 SpawnRow、注册期限）对恢复同样成立                                                                                                                                                                                                                 |
| D11 | **不 bump `SPAWNS_FILE_VERSION`**，**不扩任何持久化枚举**（`state`/`endReason`/`hint`）；恢复的细节全部放进新的可选字段 `restore`                                                                                                | bump 到 v3；新增 `endReason:"restore_failed"`                         | F13/F14：旧 hub 对 `v≠2` 或未知枚举值都是「整个文件 corrupt」，回滚后会丢掉**所有**存活孩子的身份，L4 失效。新字段对旧 hub 透明（它忽略、下次写盘时丢掉），与 delete-plan §2.6 的口径一致                                                                                                                                                                                                     |
| D12 | **`removeIntent` 绝对优先**：带删除意图的记录在关停时不打 `restoreIntent`、boot 时不进候选、恢复进行中收到删除则中止恢复                                                                                                         | —                                                                     | B-alive / B-fork：删除是用户的明确意图，复活被删的会话是最糟的结果                                                                                                                                                                                                                                                                                                                            |
| D13 | `/webhub stop` 额外写一次性 veto 文件 `<stateDir>/spawn/restore.veto`，下一次 hub boot 消费（读到即本次不恢复，并删除）；`/webhub restart` 在发 `hub_ctl` 之前删除它                                                             | 只靠 `reason:"stop"`                                                  | F6/F7：hub 卡死时 stop 走 SIGTERM 回退；如果 hub 连 signal handler 都跑不了，记录以 `live` 留在盘上，之后 `/webhub start` 拉起的 hub 会按崩溃路径恢复，违反「stop 绝不 restore」。stop marker 帮不上忙（`start` 会先删它再拉 hub）                                                                                                                                                            |
| D14 | 运行时限**仍以原 `createdAt` 为锚**（`goLive` 现有公式不变）；候选要求剩余 ≥ `RESTORE_MIN_LIFETIME_MS = 5min`                                                                                                                    | 恢复时重置为 `restoredAt + maxLifetime`                               | `maxLifetimeMinutes` 是资源兜底（arch §6.5），重启应当对它透明：既不延寿，也不缩寿。重置会让「崩溃 → 恢复」无限延寿；以 createdAt 为锚本身就是防无限复活的总时长上限。不剩几分钟的会话恢复了也只是马上又被结束                                                                                                                                                                                |
| D15 | 连续恢复上限 `RESTORE_MAX_ATTEMPTS = 3`（`restore.attempts` 在 fork 意图写入时 +1，**先落盘再 fork**）；恢复后 live 持续 `RESTORE_STABLE_MS = 2min` 清零（删除 `restore` 字段）                                                  | 不设上限；只在崩溃路径计数                                            | 防「恢复触发 hub 崩溃 → 再恢复 → 再崩溃」的循环。优雅 restart 也计数：人在 2 分钟内连续 restart 四次的代价只是最后一次不恢复，换来实现与推理都只有一套规则                                                                                                                                                                                                                                    |
| D16 | 恢复失败**不计熔断**（`breakerExempt:true`），也**不受熔断/冷却/速率**限制；但必须满足 `reaper.available`、launcher 指纹、`store.healthy`                                                                                        | 计入熔断                                                              | 熔断保护的是用户新建请求面；会话文件被删之类的恢复失败与 launcher 健康无关。L1/L2 的前置条件（能落盘、有看守）不能豁免                                                                                                                                                                                                                                                                        |
| D17 | 恢复作业并发 `RESTORE_CONCURRENCY = 2`（与 `SPAWN_STARTING_MAX` 相同），按 `createdAt` FIFO；init 只做读阶段分流，信号与 fork 全部在 init 返回后异步执行                                                                         | 全部同时恢复；在 init 里同步等                                        | 避免 N 个 pi 同时冷启动；init 有 4s 预算（`hub.ts:127`），不能被旧进程的死亡等待拖住                                                                                                                                                                                                                                                                                                          |
| D18 | `webHub.spawn.restore` 默认 **`true`**；hub 侧 `HubSpawnConfig.restore` 缺失视为 `false`                                                                                                                                         | 默认 `false`                                                          | spawn 本身默认关闭，开了 spawn 的用户显然希望网页会话可用；重启透明是默认预期。风险已被 D12–D15 限住。hub 侧缺省为 false：一个老版本 pi 拉起的新 hub 不会自作主张恢复                                                                                                                                                                                                                         |

---

## 5. 持久化 schema

### 5.1 `StoredRecord` 追加（`hub/spawn/store.ts:102`）

```ts
export type RestorePhase = "reaping" | "forking" | "registering";
export type RestoreFailure =
  | "session-missing" // 曾落盘的会话文件不见了（D7）
  | "session-invalid" // 不是普通文件 / 是符号链接 / 属主不对 / header 不可读 / header.id≠sessionId / header.cwd≠cwd
  | "prev-alive" // SIGKILL 后旧身份仍未确认死亡（L6：不 fork）
  | "prev-unknown" // 旧身份不全或 /proc 不可读（fail closed，不发信号、不 fork）
  | "scan-miss" // forking 阶段崩溃、environ 扫描没找到（可能有、可能没有）⇒ fail closed
  | "exhausted" // attempts 已达上限（D15）
  | "lifetime" // 剩余运行时限 < 5min（D14）
  | "launcher" | "reaper" | "persist" // L1/L2 前置条件不满足（D16）
  | "cwd-changed" // pinSync dev/ino 不符
  | "register-timeout" | "exited-early"; // fork 之后没能回到 live

export interface StoredRestore {
  /** 已发起的恢复 fork 次数（fork 意图写盘时 +1，先于 fork）；0..RESTORE_MAX_ATTEMPTS——
   * reaping 阶段（首个 fork 意图写入之前）为 0，开始 fork 后为 1..3。 */
  attempts: number;
  /** 最近一次状态变化时刻（审计 / 诊断用）。 */
  lastAt: number;
  /** 恢复进行中；undefined ⇒ 已回到 live（稳定期内）或已失败。 */
  phase?: RestorePhase;
  /** forking 阶段写入：environ 扫描的下界（spawnId 复用后不能再用 createdAt，§7 L1）。 */
  forkIntentAt?: number;
  /** 旧进程的 agentKey：UI 用它把详情页切到新卡片，确认旧进程死亡后从 registry 移除。 */
  prevAgentKey?: string;
  /** 失败码（伴随一个现有的 endReason 终态，D11）。 */
  failure?: RestoreFailure;
  /** 回到 live 的时刻；稳定期（2min）过后整个 restore 字段删除。 */
  restoredAt?: number;
}

// StoredRecord 追加（全部可选，旧 hub 透明）：
sessionId?: string;         // /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
sessionFile?: string;       // 绝对路径，UTF-8 ≤1024B，无 NUL/换行，以 ".jsonl" 结尾；超长 ⇒ 不写（退化为 --session-id）
sessionPersisted?: true;    // 曾观察到 sessionFile 存在（D7 的「曾落盘」证据）
restoreIntent?: true;       // 优雅 restore 关停打的标（D4）
restore?: StoredRestore;
```

### 5.2 形状校验（`isRecordShapeOk` 追加）

新 hub 对新字段**严格**：存在就必须合法，否则整文件 corrupt（与该文件现有「喂给 kill 决策，宁可不信」的口径一致，`store.ts:216-219` 注释）。`sessionId` 用上面的正则，`sessionFile` 按上面的规则，`sessionPersisted`/`restoreIntent` 只能是 `true`，`restore` 必须是对象且 `attempts` 为 0..`RESTORE_MAX_ATTEMPTS` 的整数（0 = reaping，尚未发起任何恢复 fork）、`lastAt` 为有限数、`phase`/`failure` 属于枚举、`forkIntentAt`/`restoredAt` 为有限数、`prevAgentKey` 为字符串。

`toStored()`：仅当 `cfg.restore` 为真时写 `sessionId`/`sessionFile`/`sessionPersisted`；**终态且无 `restore` 的记录不写会话字段**（无用，还占预算）。`revive()` 原样带回。

### 5.3 版本与 64 KiB 预算

- **不 bump**（D11）。读旧文件：没有 `sessionId` ⇒ 不是候选 ⇒ 现有杀孤儿行为（首次升级后的那一次重启**不会**恢复，写进 §13）。
- 预算核对（JSON 序列化后字节）：现有单条记录典型 ~0.6–0.8 KiB（`cwd` 典型 <100B，上限 4096B）。新增：`sessionId` ~50B、`sessionFile` 典型 ~150B（`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`），上限 1024B、`restore` ~150B。
  - 典型：16 非终态 × ~1.1 KiB + 20 终态 × ~0.7 KiB ≈ 31.6 KiB < 64 KiB。
  - 最坏：16 非终态 × (4096 cwd + 1024 sessionFile + ~1 KiB) ≈ 98 KiB。超过 64 KiB 目标，但仍低于 256 KiB 读上限；`trimRecordsForWrite` 先把终态裁光，然后照写并标 `oversize`（现状对超长 cwd 也是这个行为，F14）。不需要新机制；`sessionFile` 的 1 KiB 上限保证新增部分最坏只多 ~18 KiB。

---

## 6. 状态机与时序

### 6.1 单条记录（在 arch §7.5 基础上追加的边，`⟹` 为新增）

```
live ──hub close(reason ∈ RESTORE_REASONS)──⟹ stopping{hub}+restoreIntent（saveNow 先于 EOF）
        ├─ 关停窗口内 exit ──⟹ 停放：仍是 stopping+restoreIntent，exit 已记，reaper.untrack（D5）
        └─ 窗口结束仍存活 ── 核验后 SIGTERM（同现状）；reaper EOF 梯度兜底
live ──hub close(stop|signal|fence|idle) ── 现状：stopping{hub} → exited{hub}
live ──hub SIGKILL/OOM── 盘上仍是 live（含 sessionId）

[新 hub init 读阶段]
候选（§1.2 谓词 ∧ 过滤通过）──⟹ starting + restore{phase:"reaping", prevAgentKey}；agentKey 清空；identity 保持旧值
非候选 / 过滤未过 ── 现状回收（finalizeRecovered + recoverEscalate / boot-changed / environ 扫描），并附 restore.failure（若是被过滤掉的候选）

[init 返回后的恢复作业，§6.5]
starting{reaping} ──旧身份 confirmed──⟹ preflight ──ok──⟹ starting{forking}（saveNow，attempts+1，清旧 identity）
                                                    └fail⟹ failed{spawn_error}+noProcess:"never-forked"+restore.failure
starting{reaping} ──SIGKILL 后仍 alive / unknown──⟹ exited{orphan}+restore.failure（prev-alive|prev-unknown）
starting{forking} ──forkInto 成功──⟹ starting{registering}（saveNow 新 identity，reaper.track）
starting{registering} ──agent_up(pid∧cwd)+session──⟹ live（restore.phase 清除，restoredAt；+2min ⟹ 删除 restore）
starting{registering} ──注册超时 / 提前退出──⟹ failed{register_timeout|exited_early}+restore.failure
任意恢复阶段 ──stop / remove──⟹ 中止恢复，走现有停止梯（reaping 阶段停的是旧身份）
```

### 6.2 优雅 `/webhub restart` 时序（t=0：hub 收到 `hub_ctl{shutdown,restart}`）

```
t≈0      close("restart") → firstPromptFwd.dispose("hub_restart") → shutdown(d,{mode:"restore"})
         ├ 合格记录：restoreIntent=true, stop={hub}, state=stopping；不合格：现状
         ├ store.saveNow（同步，先于任何 EOF）
         └ 所有非终态 stdin.end()
t≤3s     等待（deriveBudget(10s,3000,6500)=3000ms）；退出者被停放（D5）
t≈3s     存活者核验后 SIGTERM（现状）→ flushAndClose → sink close(≤300ms) → reaper.close()
t≈3.3s   旧 reaper 收到 EOF，开始 5s grace
t≈3.5–4s hub 进程退出；restart.ts 轮询到退出（≤5s 预算）→ spawn 新 hub
t≈5–7s   新 hub init：load → 分流（读阶段）→ launcher check → reaper.start → 返回 → 调度恢复作业
         作业：旧身份多数已 confirmed（有真实 exit）⇒ 直接 preflight + fork
t≈8.3s   旧 reaper：对仍存活的旧身份核验后 TERM（多半已死 ⇒ 核验失败不发信号）
t≈11.3s  旧 reaper：核验后 KILL；≈12.3s 退出
t≈8–15s  恢复的孩子注册（pi 冷启动 + 会话加载），回到 live
```

注：restart.ts 的 5s 退出预算与 hub close 的各 STEP 预算之间的紧张关系是现有问题，restore 只新增一次同步写（毫秒级），不加剧。即使 restart.ts 判定超时没有重拉，任一在线 TUI agent 的自动拉起也会把 hub 拉起来，盘上的 `restoreIntent` 照样生效。

### 6.3 崩溃路径时序（t=0：hub 被 SIGKILL）

```
t=0      内核关闭管道：孩子 stdin EOF ⇒ pi 自行有序关停；旧 reaper stdin EOF ⇒ 5s grace
t≥0.5s   某个在线 TUI agent 的连接进入退避后拉起新 hub（无 TUI agent ⇒ 直到下次有人拉起，§9.4）
t≈1–5s   新 hub init：live+sessionId 记录成为候选 → starting{reaping}，reaper.track(旧身份)
         作业：旧身份 alive ⇒ 核验后 SIGTERM（与 pi 自身关停、旧 reaper 并行）⇒ 轮询 ≤3s ⇒ 核验后 SIGKILL ⇒ 轮询 ≤2s
t≈5s/8s  旧 reaper TERM / KILL（核验，已死则不发）
         旧身份 confirmed ⇒ preflight ⇒ fork
```

uncaughtException 走 `close("crash",{2.5s})`：等待预算为 0，打标 + 同步写 + EOF + 立即核验后 SIGTERM，盘上是 `stopping+restoreIntent`，之后与 6.2 相同。

### 6.4 boot 分流表（`init()` 读阶段；`bootChanged` 优先于一切）

| 盘上记录                                                       | restore 开 ∧ 无 veto                                                                                                                                  | restore 关 或 有 veto                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 任意非终态，`bootChanged`                                      | 现状（`boot-changed`，不发信号）                                                                                                                      | 现状                                                       |
| 带 `removeIntent`                                              | 现状（delete 收敛，F9）——**不进候选**                                                                                                                 | 现状                                                       |
| `live` + 合法 `sessionId`（崩溃路径）                          | 候选                                                                                                                                                  | 现状 orphan 回收                                           |
| `live`，无 `sessionId`（旧格式 / restore 关时写的）            | 现状 orphan 回收                                                                                                                                      | 现状                                                       |
| `stopping` + `restoreIntent` + `sessionId`（优雅路径，含停放） | 候选（有真实 `exit` ⇒ 旧身份立即 confirmed）                                                                                                          | 现状 orphan 回收                                           |
| `stopping`，无 `restoreIntent`（user/lifetime/stop/…）         | 现状 orphan 回收                                                                                                                                      | 现状                                                       |
| `starting` + `restore.phase ∈ {reaping, registering}`          | 候选（attempts 延续）                                                                                                                                 | 现状 orphan 回收                                           |
| `starting` + `restore.phase === "forking"`（无 pid）           | 以 `forkIntentAt-1s` 为下界做 environ 扫描：命中 ⇒ 以命中身份为旧身份进候选；未命中 ⇒ `failed{spawn_error}` + `restore.failure:"scan-miss"`，不发信号 | 现状 environ 扫描（以 createdAt 为下界——仍正确，只是更宽） |
| `starting`，无 `restore`（全新、未 live）                      | 现状 orphan 回收（D3）                                                                                                                                | 现状                                                       |
| `launching`                                                    | 现状 environ 扫描                                                                                                                                     | 现状                                                       |
| 终态                                                           | 保留，不复活                                                                                                                                          | 保留                                                       |

候选再经过滤（任一不过 ⇒ 走「现状 orphan 回收」+ 记 `restore.failure`）：剩余运行时限 ≥5min（`lifetime`）；`attempts < 3`（`exhausted`）；身份四元组完整（`prev-unknown`，无信号）。

候选在读阶段的改写：`state="starting"`，`restore.phase="reaping"`，`restore.prevAgentKey = agentKey ?? restore.prevAgentKey`，`agentKey=undefined`，`linked=false`，`everLive=true`，`breakerExempt=true`，`firstPrompt=undefined`，`restoreIntent` 删除，`hint/hintDetail/uiCancelled` 清空；**`pid/procStartTicks/bootId/uid/exit` 保持旧值**（`computeDeath` 与停止梯都直接作用在旧身份上，§8.1）。读阶段结束 `persistDebounced()` + `schedulePush()`（与现状 `mutated` 分支同一处）。veto 文件在读阶段读取并 `unlinkSync`（删除失败只记日志，本次照样视为 veto）。

### 6.5 恢复作业（每条候选一个，`RESTORE_CONCURRENCY=2`）

init 末尾（launcher check 与 `reaper.start` 都已完成）调用 `scheduleRestores()`：

0. **前置**：`reaperOk` 为假 / launcher 检查失败 ⇒ 对全部候选降级：`finalizeRecovered(rec)` + `recoverEscalate(旧身份)` + `restore.failure = "reaper" | "launcher"`，结束。否则对每条候选 `reaper.track(旧身份)`（L2：恢复期间旧进程同样被看守）。
1. **reaping**（检查点：`closedFlag`、`records.get(id)===rec`、`rec.state==="starting"`、`rec.restore?.phase==="reaping"`、`!rec.removePending`，任一不成立 ⇒ 静默退出作业，后续由当前状态的既有路径接管）
   - `computeDeath(rec)`：`confirmed` ⇒ 步骤 2。
   - `unknown` ⇒ `failure:"prev-unknown"`，`finalizeRecovered(rec)`（不发信号），结束。
   - `alive` ⇒ 同步段内 `verifyIdentityById(旧身份, true)` 通过才 `groupKill(SIGTERM)`；以 100ms 间隔（unref timer）轮询 `computeDeath`，至多 `RESTORE_TERM_WAIT_MS = 3000`；仍 alive ⇒ 同步段内核验后 `SIGKILL`，再轮询至多 `RESTORE_KILL_WAIT_MS = 2000`；仍非 confirmed ⇒ `failure:"prev-alive"`，`finalizeRecovered(rec)`（记录终态 `exited{orphan}`，reaper 仍在看守 ⇒ 它会在 hub 死后接着处理），结束。
   - 预算对照：shutdown 的 6.5s 是整个 close 的保留量，不是单进程等待；`recoverEscalate` 是 TERM 后固定 3s 再 KILL、不确认结果。这里取 3s + 2s = **≤5s** 且以确认死亡为出口，因为恢复要据此决定是否 fork（L6），必须有明确结论。旧进程的父进程（旧 hub）已死，它被 init/subreaper 收养后会被及时回收；回收前的 Z 状态 `probeIdentity` 也判 confirmed。
   - 确认死亡后：`reaper.untrack(旧 pid)`；若有 `prevAgentKey` ⇒ `deps.onPrevAgentGone?.(spawnId, prevAgentKey)`。
2. **preflight**（全部同步）：`closedFlag`/`store.healthy`/`reaper.available`/launcher 指纹复核（`recheckLauncherSync`）任一失败 ⇒ 对应 `failure`；会话坐标：
   - `sessionFile` 已知：`lstatSync` 不存在 ⇒ `sessionPersisted ? "session-missing" : 走 --session-id`；存在但不是普通文件 / 是符号链接 / `uid≠getuid()` ⇒ `session-invalid`；读首行（≤4 KiB，与 `dirs.ts` 读会话 header 同法）解析失败、`type!=="session"`、`id!==sessionId`、`cwd!==rec.cwd` ⇒ `session-invalid`（`hintDetail` 记具体原因，仅 owner 可见）；全部通过 ⇒ `["--session", sessionFile]`。
   - `sessionFile` 未知 ⇒ `["--session-id", sessionId]`（pi 本项目精确查找，命中即打开，F23）。
   - preflight 失败 ⇒ `state="failed"`，`endReason="spawn_error"`，`noProcess="never-forked"`（新进程从未 fork、旧进程已确认死亡 ⇒ 删除可立即确认），清旧 identity，`restore.phase` 清除，经 `finalizeTerminal` 收尾（审计 / 推送 / 落盘）。
3. **forking**（L1 第一写）：清 `pid/procStartTicks/bootId/uid/exit/endReason/stop`；`restore.phase="forking"`、`forkIntentAt=now`、`attempts+=1`、`lastAt=now`；`store.saveNow` 失败 ⇒ 按 2 的失败路径，`failure:"persist"`。
4. **forkInto**（从 `start()` 的 ②–④ 段抽出的共享函数，§10.3）：`pinSync`（记录里的 dev/ino；不符 ⇒ `cwd-changed`，`noProcess:"never-forked"`）→ umask 切换 → `spawnFn(launcher[0], [launcher[1], "--mode", "rpc", ...sessionTail], …)`（env 与新建完全相同，`PI_WEBHUB_SPAWN_ID` 复用 spawnId）→ 同步段读身份 → `restore.phase="registering"` → `saveNow`（L1 第二写）→ `reaper.track` → 挂 stdio/stderr/exit 监听 → spawn 事件定时器 → `registerDeadlineAt = forkAt + min(2×registerTimeoutS×1000, 240_000)`。
5. **registering** → 现有绑定链路（`agent_up` pid∧cwd 匹配 → `session` → `goLive`）。`goLive` 对恢复记录额外：`sessionId` 与持久化值不一致时记 warn + 审计并采用新值（D7 已保证正常情况下一致，属防御）；`restore.phase` 清除、`restoredAt=now`、`saveNow`；armed `RESTORE_STABLE_MS` unref 定时器 ⇒ 到期仍 live 则删除 `restore`、`persistDebounced`。`lifetimeDeadlineAt` 沿用现有公式 `createdAt + maxLifetime`（D14）。
6. **fork 后失败**：`finalizeTerminal` 对 `rec.restore?.phase !== undefined` 的记录按 `endReason` 补 `failure`（`register_timeout→"register-timeout"`、`exited_early→"exited-early"`、`spawn_error→` 保持已有值），清 `phase`。`breakerExempt` 已为真 ⇒ 不计熔断。

所有 timer 都 `unref()`；`shutdown()` 置 `closedFlag` 后作业在下一个检查点退出，不再发信号、不再 fork；记录以当前阶段持久化，下一次 boot 按 §6.4 接续。

### 6.6 reaper 与恢复梯度的「双打」时序分析

参与方：旧 hub 的 reaper（只跟踪**旧**身份，hub 死后 5s TERM、8s KILL）、pi 自身（EOF 后有序关停；第二次 SIGTERM 时直接 `process.exit`，arch §7.3）、新 hub 的恢复作业（跟踪旧身份 + 自己 fork 的新身份）、新 hub 的 reaper（`track(旧身份)` + `track(新身份)`）。

| 交叠                                                       | 结论                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧 reaper 与恢复作业同时对旧进程发 TERM                    | 幂等，而且有益：pi 已在关停中时第二个 SIGTERM 让它立即退出                                                                                                                      |
| 两边都对旧进程发 KILL                                      | 期望的结果就是它死。每一方发信号前都在同一同步段内核验身份（旧 reaper 用内联脚本里的同一算法，arch §7.4），进程已死 ⇒ 核验失败 ⇒ 不发                                           |
| 旧 reaper 会不会杀到新 fork                                | 不会。L6 保证新 fork 只发生在旧身份 confirmed 之后；旧 reaper 只认旧身份的 `starttime`，新进程的 starttime 必然不同 ⇒ 核验失败                                                  |
| pid 复用（新 fork 拿到与旧进程相同的 pid）                 | `kill(-pid)` 的组号也相同，但核验先于信号且比较 starttime ⇒ 不发。核验到 kill 之间的同步段为微秒级，与现状 L5 的已接受姿态相同                                                  |
| SIGKILL 落在 pi 正在追加会话文件的瞬间                     | 可能截断最后一行。这是现有 reaper / 停止梯就有的风险（不是 restore 引入的）；恢复梯度先 TERM、给 3s，最大程度让 pi 走完有序关停。pi 读到残缺尾行时的行为列入 CR 验证项（§12.3） |
| 新 hub 在旧 reaper 5s grace 之前就开始恢复（崩溃路径常见） | 恢复作业自己发 TERM/KILL，不依赖旧 reaper；两者只是更早汇合                                                                                                                     |
| 新 hub 永不起来                                            | 旧 reaper 照常在 ≤12s 内清掉所有旧进程（L3 不变），盘上的恢复意图等到下一次 hub boot（受 D14/D15 约束）                                                                         |

**reaper 不需要知道 restore 语义**：它的契约仍然只有「hub 管道 EOF ⇒ 核验后 TERM→KILL 我跟踪的身份」。恢复只是新 hub 在自己存活期间 fork 的普通受管进程，走全套 L1/L2。

---

## 7. L1–L5 孤儿不变量逐条影响评估（+ 新增 L6）

| #   | 不变量（arch §7.2）                        | 影响                                                                                                                                                                                                                                                                                                                                                                                                                                  | 结论                   |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| L1  | 意图先于子进程；pid+身份同一同步段落盘     | 恢复 fork 走同一个 `forkInto`：先 `saveNow(forking + forkIntentAt + attempts)`，fork 后同步段 `saveNow(registering + 新身份)`。**唯一需要调整的地方**：spawnId 复用后，environ 扫描（F8）若仍以 `createdAt-1s` 为下界，会把同 spawnId 的任何进程都当成目标（包括已死旧进程留下、带同一 env 的后代）。因此 forking 阶段崩溃时扫描以 `forkIntentAt-1s` 为下界（§6.4）。扫描未命中仍按现状 fail closed（不发信号，`scan-miss`，不 fork） | 保持（含一处下界调整） |
| L2  | hub 存活期间每个非终态子进程被 reaper 看守 | 恢复中的记录在 reaping 阶段 `reaper.track(旧身份)`，registering 阶段 track 新身份；`reaper.onRestart` 的「重新 track 全部非终态且有身份的记录」自动覆盖两种阶段。reaper 不可用 ⇒ 不恢复（D16），降级为现状回收                                                                                                                                                                                                                        | 保持                   |
| L3  | hub 以任何方式死亡后 ≤12s 内所有子进程结束 | 不活收养；restore 模式的关停与现状一样 EOF + 存活者 SIGTERM + 关 reaper stdin；崩溃时的 EOF 与 reaper 完全不变。恢复期间新 hub 若再死，旧身份（reaping）和新身份（registering）都在新 reaper 的跟踪表里 ⇒ 同样 ≤12s                                                                                                                                                                                                                   | 保持                   |
| L4  | 双重失效时下次启动兜底                     | 候选在下次 boot 由恢复作业先确认旧身份死亡（核验后 TERM→KILL，带确认），比 `recoverEscalate` 更强；非候选完全走现状。回滚到旧 hub：新字段被忽略，持久化枚举未扩展（D11）⇒ 旧 hub 的回收照常（`starting{forking}` 无 pid 的记录在旧 hub 上走「无完整身份 ⇒ 无信号 orphan」，那个可能存在的新进程在 hub 死时已收到 EOF，且曾被已死 hub 的 reaper 跟踪——两者都没时才是残余风险，与现状 L4 同级）                                         | 保持                   |
| L5  | 任何 kill 前同一同步段核验身份             | 恢复作业的 TERM/KILL 全部经 `verifyIdentityById`；死亡判定用只读 `probeIdentity`，不发信号；`onPrevAgentGone` 只动 registry 卡片，不发信号                                                                                                                                                                                                                                                                                            | 保持                   |
| L6  | **（新增）单会话单进程**                   | 旧身份 `computeDeath` 不为 `confirmed`（`alive`/`unknown`）⇒ 绝不 fork 恢复进程。保证同一会话文件在任何时刻至多有一个 hub 受管的 pi 写者                                                                                                                                                                                                                                                                                              | 新增，HR2 钉住         |

已接受的残余风险（不变 + 新增说明）：hub 与 reaper 同时被杀、且 hub 永不重启（arch L4 原有）。新增：用户在 hub 死亡窗口内用终端 `pi --session` 打开了同一会话 ⇒ 恢复后有两个写者（pi 本身没有会话锁，与今天手动 resume 的风险相同，不在 hub 能管的范围内）。

---

## 8. 与既有契约的交互

### 8.1 删除会话（delete-plan B-alive / B-fork / B-stream）

| 场景                                  | 行为                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关停时记录带 `removePending`          | 不打 `restoreIntent`，走现状（`stopping{hub}` + `removeIntent`，boot 收敛删除）                                                                                                                                                                                                                                                                                            |
| boot 时记录带 `removeIntent`          | 不进候选（§6.4 第二行）                                                                                                                                                                                                                                                                                                                                                    |
| 恢复 reaping 阶段收到删除 / stop      | `remove()` 现有分支：非终态 ⇒ `removePending=true` + `saveNow` + `enterStopping("user")`。因 identity 仍是旧身份，停止梯直接作用在旧进程上（无 child ⇒ 第 0 级 EOF 为空操作；实现上对 `restore.phase==="reaping"` 直接从第 1 级开始，省掉 5s 空等）。恢复作业在下一个检查点看到 `state!=="starting"` 退出。`finalizeTerminal` → `computeDeath` 判旧进程 ⇒ confirmed 则删除 |
| 恢复 forking/registering 阶段收到删除 | 新 child 已存在（或 forking 的同步段内不可能插入请求），走现有停止梯                                                                                                                                                                                                                                                                                                       |
| B-fork                                | 恢复不经过创建路由与幂等 LRU，不会因重放而多 fork；被删记录在 boot 时不进候选                                                                                                                                                                                                                                                                                              |
| B-stream                              | agentKey 换新 ⇒ 新卡片 `history:"none"`，选中时重新 subscribe → history 快照（新进程打开同一会话文件 ⇒ 历史完整）→ 增量；旧 key 由 `registry.remove` 广播 `agent_removed`，按 delete-plan §2.3 的顺序清掉旧订阅                                                                                                                                                            |

### 8.2 首条消息

关停时 `firstPromptFwd.dispose("hub_restart")` 先于 shutdown（F3），未送达 ⇒ `expired{hub_restart}` 并推送，发起标签页把正文放回草稿（现状）。恢复记录读阶段清空 `firstPrompt` 槽位；转发器对它没有条目，`onLive` 直接返回（F25）。

### 8.3 `/webhub stop` 绝不恢复

- ctl 路径：`reason:"stop"` ⇒ terminate 模式（现状），盘上留下的是 `stopping{hub}`/`exited{hub}`，不满足候选谓词。
- 卡死回退路径（SIGTERM）：hub 若还能跑 handler ⇒ `close("signal")` ⇒ terminate；跑不了 ⇒ 记录以 `live` 留在盘上 ⇒ 由 veto 文件挡住（D13）。veto 只影响**紧接着的那一次** boot。
- `/webhub start` 不删 veto；`/webhub restart` 删除 veto（显式的 restart 意图压过之前的 stop）。

### 8.4 supersede

`superseded` 在恢复原因集合里（D2，待确认）。supersede 的静默判据（受管 busy 时不 quiet，`supersede.ts`）**不放宽**：恢复会丢掉进行中那一轮的输出，等空闲仍有价值。恢复用的是新 hub 的 launcher，所以会话会顺带升级到新插件版本。

### 8.5 版本观察

`hub.ts` 的 `onVersion` 门用 `spawnSup.isManaged(key)`。恢复期间旧进程可能重连并发版本，若当成非受管 agent 送进 `supersede.observe`，一个更新版本的旧孩子可能触发新 hub 的版本替换。`isManaged` 扩展为：非终态且 `agentKey===key`，**或** `restore.phase==="reaping"` 且 `restore.prevAgentKey===key`。

---

## 9. 用户可见语义

### 9.1 卡片与 SpawnRow

| 时刻                  | 网页上看到的                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 重启中            | 现有 hub-state-banner（restarting / 重连中）                                                                                                                                                                                                                     |
| 新 hub 起来、恢复中   | 记录 `state:"starting"` + `restore.phase` ⇒ `pendingRows` 显示一行 SpawnRow，文案 `restoring`（行内英文 token）+ 阶段提示；`pid`/`exit` 在 reaping 阶段不投影（避免显示旧进程信息）                                                                              |
| 旧进程短暂重连（F20） | 一张旧 agentKey 的卡片可能闪现。UI 用 `restore.prevAgentKey` 识别：该卡片显示 `restoring` 徽标、**禁用 composer**（发给它的 prompt 会随它被杀而丢失）。旧进程确认死亡后 `agent_removed` 把它移除                                                                 |
| 恢复成功              | 新卡片出现（`web` 徽标照旧），SpawnRow 消失；稳定期内可选显示 `restored` 小徽标。正在看旧 key 详情页的用户：`logic/spawn.js` 的 `successorOf(spawns, oldKey)` 找到 `restore.prevAgentKey===oldKey` 的记录后自动切到新 key（而不是 delete-plan 的「已删除」空态） |
| 恢复失败              | SpawnRow 显示 failed + `restore.failure` 的本地化文案（中文提示语句，例如「会话文件已不存在，无法恢复」）；owner 可点「详情」看 `hintDetail`                                                                                                                     |
| 进行中那一轮          | 会话里最后一条 user 消息没有回复；可选在新卡片上给一次性提示「上一轮输出因 hub 重启中断」（不阻塞，S2 可做）                                                                                                                                                     |

`useNewSession` 的「我发起的 ⇒ live 后自动跳转」认领逻辑必须排除带 `restore` 的记录（spawnId 复用、`origin.reqId` 不变，否则发起标签页会在恢复后被拽走）。

### 9.2 Public 投影（`project.ts` 的 `toPublic`/`toViewer` 与 `supervisor.publicItem` 两套都加）

`restore?: { phase?: RestorePhase; attempt: number; failure?: RestoreFailure; prevAgentKey?: string; restoredAt?: number }`——全部字段对所有主体可见（无路径、无正文）。`sessionId`/`sessionFile` **不上 wire**（arch §6.4 的 `sessionFile` 行不变）。

### 9.3 `/webhub restart` / `stop` 的 TUI 提示

arch §7.8 说 TUI 提示里显示 hub.json 的 `spawn.count`。restore 开启时 restart 的提示改为「N 个网页会话将在 hub 重启后恢复（进行中的一轮输出会丢失）」，stop 的提示保持「将结束」。

### 9.4 已知语义边界

- 崩溃后如果没有任何在线 TUI agent，hub 要等下次有人拉起；届时仍满足 D14（剩余时限）/D15（次数）的记录才恢复。
- 首次升级到本版本后的第一次重启不恢复（旧 hub 没写 `sessionId`，§13）。

---

## 10. 接口契约

### 10.1 protocol（`protocol/spawn.ts`，只追加）

```ts
export type RestorePhase = "reaping" | "forking" | "registering";
export type RestoreFailure = /* §5.1 同名联合 */;
export interface SpawnRestoreWire {
  phase?: RestorePhase;
  attempt: number;
  failure?: RestoreFailure;
  prevAgentKey?: string;
  restoredAt?: number;
}
// SpawnRecordPublic 追加：restore?: SpawnRestoreWire;
// HubSpawnConfig 追加：restore?: boolean;   // 缺失 ⇒ false（D18）

export const RESTORE_MAX_ATTEMPTS = 3;
export const RESTORE_STABLE_MS = 120_000;
export const RESTORE_MIN_LIFETIME_MS = 300_000;
export const RESTORE_TERM_WAIT_MS = 3_000;
export const RESTORE_KILL_WAIT_MS = 2_000;
export const RESTORE_POLL_MS = 100;
export const RESTORE_CONCURRENCY = 2;
export const RESTORE_REGISTER_MAX_MS = 240_000;
export const RESTORE_SESSION_FILE_MAX_BYTES = 1024;
export const RESTORE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
```

`SpawnState`、`SpawnEndReason`、`SpawnHint`、`PROTO` 均**不变**。

### 10.2 supervisor（`hub/spawn/supervisor.ts`）

```ts
export type ShutdownMode = "terminate" | "restore";
interface SpawnSupervisor {
  // 改：可选第二参数，缺省 terminate ⇒ 现有调用方与测试零改动
  shutdown(deadline: ReqDeadline, opts?: { mode?: ShutdownMode }): Promise<void>;
  // 其余签名不变；isManaged 语义按 §8.5 扩展
}
interface SpawnSupervisorDeps {
  // 新增（可选）
  /** 恢复确认旧进程死亡后调用一次；hub.ts 接到 registry.remove(prevKey, {allowConnected:true})。 */
  onPrevAgentGone?: (spawnId: string, prevAgentKey: string) => void;
  /** 会话文件 preflight 的同步 fs 接缝（默认 node:fs）。 */
  sessionFs?: {
    lstatSync(p: string): { isFile(): boolean; isSymbolicLink(): boolean; uid: number };
    readHeadSync(p: string, maxBytes: number): string;
  };
  /** restore.veto 路径（webHubSpawnFiles(stateDir).restoreVeto）；undefined ⇒ 不检查。 */
  restoreVetoFile?: string;
}
```

`shutdown(restore)` 的打标谓词 `eligibleAtShutdown(rec)`：`cfg.restore === true ∧ !rec.removePending ∧ RESTORE_SESSION_ID_RE.test(rec.sessionId ?? "") ∧ (rec.state === "live" ∨ (rec.state === "starting" ∧ rec.restore?.phase !== undefined))`。打标的记录 `state="stopping"`、`stop={reason:"hub", terminalState:"exited", stage:0}`、`restoreIntent=true`；然后**一次** `store.saveNow(storedSnapshot())`（失败只记日志——意图只在内存，结局退化为现状回收，安全）；之后与现状完全相同。`finalizeTerminal` 开头追加停放分支：`if (closedFlag && rec.restoreIntent === true) { clearRecordTimers; if (pid) reaper.untrack(pid); cleanupHandles; persistDebounced(); return; }`。

### 10.3 `forkInto`（从 `start()` 抽取，`start()` 行为逐字节不变）

```ts
function forkInto(
  rec: Supervised,
  pin: { fd: number; cwdArg: string },
  argvTail: readonly string[], // start(): model ? ["--model", m] : []；restore: §6.5 的会话参数
  registerDeadlineAt: number, // start(): t0 + registerTimeoutS*1000；restore: forkAt + min(2×…, 240s)
  onPersistedIdentity: () => void, // start(): state="starting"；restore: restore.phase="registering"
): "ok" | "spawn-threw" | "no-child" | "persist-failed";
```

覆盖 `supervisor.ts` 中 umask 切换 + `spawnFn` + `closeFd` + 身份读取 + L1 第二写 + `reaper.track` + 监听挂载 + spawn 事件定时器 + 注册定时器这一段（约 `:1356-1480`）。spawn-plan SP7 验收第 1、6 条（调用顺序、argv/env/umask）必须原样通过。

### 10.4 hub 装配（`hub/hub.ts`）

```ts
const RESTORE_REASONS: ReadonlySet<string> = new Set(["restart", "superseded", "crash"]);
// close(): `if (spawnSup !== undefined) await spawnSup.shutdown(deadline, {
//            mode: spawnCfg?.restore === true && RESTORE_REASONS.has(reason) ? "restore" : "terminate" });`
// createSpawnSupervisor({..., onPrevAgentGone: (_id, key) => registry.remove(key, { allowConnected: true }),
//                        restoreVetoFile: spawnFiles.restoreVeto })
```

### 10.5 agent 侧（只动设置下发与 admin 命令）

- `agent/index.ts` 的 `WebHubSpawnSettings` / `buildHubConfig`：`spawn.enabled` 为真时 `config.spawn.restore = settings.spawn.restore`（`enabled` 为假时仍不写 `spawn` 键，`PI_WEBHUB_CONFIG` 与现状深相等）。
- `agent/admin-cmds.ts`：`stop()` 在写 stop marker 之后、`stopHub()` 之前写 veto（`writeFileSync(0o600)`，失败只记日志、不阻止 stop）；restart 流程在 `restartHub()` 之前 `unlinkSync` veto（ENOENT 视为成功）。
- `protocol/paths.ts` 的 `webHubSpawnFiles()` 返回值加 `restoreVeto`（`<logDir 的父目录 spawn/>/restore.veto`，与 stderr 日志同目录、0700）。

### 10.6 审计（`hub/audit.ts`）

`SpawnAuditRecord` 加 `restore?: "intent" | "reap" | "fork" | "live" | "stable" | "fail" | "veto"`、`restoreFailure?: RestoreFailure`、`attempt?: number`；`SPAWN_AUDIT_KEYS` 同步。不记录 `sessionFile`、`sessionId`。

---

## 11. 施工分解

路径相对 `src/web-hub/`（另注明者除外）。依赖：RS1 → {RS2, RS3} → RS4 → RS5 → RS6；RS7 只依赖 RS1；RS8 最后。每包走 dev-flow，开发返回后由不同模型验收；全局闸门 `npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web`。

| 包  | 内容                              | 改动文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RS1 | 协议类型、常量、store schema      | `protocol/spawn.ts`（§10.1）；`protocol/paths.ts`（`restoreVeto`）；`hub/spawn/store.ts`（`StoredRecord` 追加、`isRecordShapeOk` 追加；`END_REASONS`/`HINTS` **不动**）                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/web-hub/hub/spawn/store.test.ts` 追加：新字段往返；每个新字段的非法值 ⇒ 整文件 corrupt；`sessionFile` 1025B 被拒；**回滚兼容**：用旧版 `isRecordShapeOk` 的快照（或断言 `END_REASONS`/`HINTS` 集合与 `547635d` 逐项相等）证明新 hub 写出的任何记录都只用旧枚举；`tests/web-hub/protocol/spawn.test.ts` 追加常量与正则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RS2 | 设置与下发                        | `config/settings.ts`（`DEFAULT_WEBHUB_SPAWN_SETTINGS.restore = true`、`parseWebHubSpawnBlock`）；`config/setting-specs.ts`（`webHub.spawn.restore`，bool，描述注明「/reload 再 /webhub restart」）；`agent/index.ts`（`WebHubSpawnSettings`、`buildHubConfig`）；`hub/spawn/config.ts`（`parseHubSpawnConfig`：`restore` 可选 bool，非 bool ⇒ 整块拒绝）                                                                                                                                                                                                                  | `tests/config/web-hub-settings.test.ts`；`tests/web-hub/agent/wiring-spawn.test.ts`（enabled 假 ⇒ 深相等不变；真 ⇒ 字段数 +1）；`tests/web-hub/hub/spawn/config.test.ts`（缺失 ⇒ false）；`tests/ui/settings-editor.test.ts` 表全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RS3 | 会话坐标持久化 + 投影             | `hub/spawn/supervisor.ts`：`goLive` 写 `sessionId`/`sessionFile`（来自 `registry.get(key).session`）并 `saveNow`（仅 `cfg.restore`）；`onBusEvent` 的 `session` 分支增加 live 记录的会话切换（更新 + `saveNow`，`sessionPersisted` 重置为按新文件判定）；`status` 分支在 `busy` 由真转假时对未确认的记录 `statSync(sessionFile)` 一次，存在 ⇒ `sessionPersisted=true` + `persistDebounced`；`toStored`/`revive`/`publicItem`；`hub/spawn/project.ts` 两个投影                                                                                                             | `supervisor.test.ts` 追加：goLive 后 `saveNow` 恰好一次且含 `sessionId`；`cfg.restore=false` ⇒ 写出的 JSON 与现状逐字节一致（快照）；会话切换更新坐标；`sessionPersisted` 只在文件存在时置真、置真后不再 stat；`project.test.ts`：`restore` 字段在 SSE/GET 各列可见，`sessionId`/`sessionFile` 在任何投影中都不出现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RS4 | 关停分叉 + 停放 + reason 映射     | `hub/spawn/supervisor.ts`（`shutdown(deadline, opts)`、`eligibleAtShutdown`、`finalizeTerminal` 停放分支）；`hub/hub.ts`（`RESTORE_REASONS`、`:1077` 传 mode）                                                                                                                                                                                                                                                                                                                                                                                                            | `supervisor.test.ts`：restore 模式下 `saveNow` 先于任何 `stdin.end()`（调用顺序 spy）；`removePending` 记录不打标；全新 starting 不打标；窗口内 exit ⇒ 状态仍 `stopping`、`reaper.untrack` 被调用、`onTerminal` 未调用、未进 trim；存活者 SIGTERM 与现状一致；terminate 模式与现状**逐行为一致**（复用原有 shutdown 用例）。`tests/web-hub/hub/hub-spawn.test.ts`：`close("restart"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | "superseded" | "crash")` ⇒ mode restore；`stop`/`signal`/`fence`/`idle` ⇒ terminate；`spawn.restore=false` ⇒ 一律 terminate |
| RS5 | boot 分流 + 恢复作业 + `forkInto` | `hub/spawn/supervisor.ts`（`init` 读阶段分流、veto 消费、`scheduleRestores`、作业状态机、`forkInto` 抽取、`isManaged` 扩展、`stop()`/`remove()` 对 reaping 阶段从第 1 级起梯）；新文件 `hub/spawn/restore-plan.ts`（**纯函数**：`classifyForRestore(stored, ctx) → {kind:"candidate"} \| {kind:"skip", failure} \| {kind:"legacy"}`、`planSessionArgv(rec, fs) → {ok:true, tail} \| {ok:false, failure, detail}`，无 pi import、无副作用）                                                                                                                                | `tests/web-hub/hub/spawn/restore-plan.test.ts`（新）：§6.4 表逐行 × restore 开/关 × veto；过滤三项；`planSessionArgv` 的 D7 全分支（存在 / 缺失+未落盘 / 缺失+曾落盘 / 符号链接 / uid 不符 / header 损坏 / id 不符 / cwd 不符 / sessionFile 未知）。`supervisor.test.ts`：作业时序（fake timers + 注入 `/proc`）：confirmed ⇒ 立即 fork；alive ⇒ 核验后 TERM、3s 后核验后 KILL、2s 后仍 alive ⇒ `prev-alive` 且 **spawnFn 未调用**（L6）；unknown ⇒ 不发信号不 fork；每次 kill 前都有核验；fork 意图写在 spawnFn 之前（L1 顺序）、`attempts` 先落盘；forking 阶段崩溃的扫描下界为 `forkIntentAt-1s`；恢复 argv 恰为 `[launcher[1],"--mode","rpc","--session",file]`（无 `--model`）；注册期限从 fork 时刻起算；lifetime 锚定 createdAt；stable 定时器删除 `restore`；`closedFlag` 后作业不再发信号；reaping 阶段 `remove()` ⇒ 删除意图 + 旧身份停止梯 + 作业退出；`start()` 原 SP7 验收 1/6 原样通过 |
| RS6 | hub 装配 + 审计                   | `hub/hub.ts`（`onPrevAgentGone`、`restoreVetoFile`、`onVersion` 经扩展后的 `isManaged`）；`hub/audit.ts`（§10.6）；`agent/admin-cmds.ts`（veto 写 / 删）                                                                                                                                                                                                                                                                                                                                                                                                                  | `hub-spawn.test.ts`：`onPrevAgentGone` ⇒ `registry.remove(prevKey,{allowConnected:true})`，且只在死亡确认之后；旧 key 带更新版本重连 ⇒ 不进 `supersede.observe`；`audit.test.ts`：新键白名单；`tests/web-hub/agent/admin-cmds.test.ts`：stop 写 veto（写失败不阻止 stop）、restart 删 veto、start 不碰 veto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| RS7 | UI                                | `ui/src/logic/spawn.js`（`pendingRows` 的 restoring 标签、`isMine` 排除 `restore`、`successorOf`、`restoringKeys`）；`ui/src/components/spawn/SpawnRow.vue`；`ui/src/components/agents/AgentCard.vue`（prevAgentKey 卡片的 `restoring` 徽标）；`ui/src/components/detail/DetailHeader.vue` + composer 禁用（经现有 `ControlHandle`/props，不改 `Composer.vue`）；`ui/src/i18n/{en,zh}/spawn.ts`；`ui/src/types.ts`（类型追加）                                                                                                                                            | `tests/web-hub/ui/logic-spawn.test.ts`：恢复各阶段的行渲染、`successorOf` 映射、`isMine` 对恢复记录为假；`use-new-session.test.ts`：恢复记录 live 不触发跳转；`detail-header.test.ts`：正在看旧 key 时切到新 key、旧 key 卡片 composer 禁用；`i18n-parity.test.ts`；`npm run build:web && npm run check:web`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RS8 | 集成、conformance、验收、文档     | `tests/integration/fixtures/fake-rpc-pi.mjs`（解析 `--session <file>`：读 header 的 `id` 作为 `sessionId` 上报；`--session-id <id>`：直接用该 id；`FAKE_ARGV_OUT` 已有）；`tests/integration/web-hub-headless.test.ts`（HR1–HR7）；`tests/conformance/rpc-spawn.test.ts`（CR1–CR3）；`docs/dev/web-hub-spawn/acceptance.md`（追加 restore 真机步骤）；`docs/dev/web-hub-spawn/arch.md`（§3.1「跨 hub 重启存活」行、§4.2「`/webhub restart`」条目加勘误指向本文）；`AGENTS.md`（`src/web-hub/` 条目 Managed spawn 段落加一句 restore 摘要：默认开、杀旧重 fork、L6、veto） | 见 §12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 12. 测试计划

### 12.1 单元（随各包，见 §11）

重点硬门槛（不过不合入）：RS1 回滚兼容（持久化枚举集合不变）；RS4 「`saveNow` 先于 EOF」；RS5 L6（旧身份未 confirmed ⇒ spawnFn 调用 0 次）、L1 顺序、L5 每次 kill 前核验；RS3 `cfg.restore=false` 逐字节一致。

### 12.2 集成硬门槛（`tests/integration/web-hub-headless.test.ts`，新增 describe「HR restore」；H9 已被 default-model 占用，故用 HR 前缀）

| #   | 场景                                                                                                                                                                  | 断言                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR1 | **优雅 restart**：spawn fake（`--cmd-echo`，预置会话文件）→ live → 经 agent socket 发 `hub_ctl{shutdown, restart}` → 测试拉起新 hub                                   | 同一 spawnId 回到 `live`；新 pid ≠ 旧 pid；agentKey 改变且 `restore.prevAgentKey` 等于旧 key；fake 的 argv 尾部恰为 `--session <会话文件绝对路径>`、不含 `--model`；新卡片 session 帧的 `sessionId` 与旧值相同（会话连续）；`agent_removed{旧 key}` 已广播；`restore` 字段在 `RESTORE_STABLE_MS`（测试钩子缩短）后消失 |
| HR2 | **崩溃（kill -9 hub，reaper 存活）**，fake `--ignore-eof`（模拟慢退出）；2s 内拉起新 hub                                                                              | 记录恢复到 live；**全程以 50ms 采样 `/proc/*/environ` 中 `PI_WEBHUB_SPAWN_ID=<spawnId>` 且 comm=pi 的进程数，恒 ≤1**（L6）；旧 pid 被核验后的 TERM/KILL 结束                                                                                                                                                           |
| HR3 | **退化**：手写 spawns.json（`v:2`、`live`、完整身份、**无 `sessionId`**，旧格式）+ 一个真实 fake 进程 → 启动 hub                                                      | 行为与 H3 相同：TERM→KILL，记录 `exited{orphan}`；spawnFn 调用 0 次；无 `restore` 字段                                                                                                                                                                                                                                 |
| HR4 | **恢复失败（会话文件被删）**：live 后让 fake 完成一轮（`sessionPersisted` 被置真）→ 删会话文件 → restart                                                              | 记录 `failed{spawn_error}` + `restore.failure:"session-missing"` + `noProcess:"never-forked"`；spawnFn 调用 0 次；随后 `POST /api/agents/remove` ⇒ 200（死亡可确认）                                                                                                                                                   |
| HR5 | **stop 不恢复 + 删除优先**：(a) `hub_ctl{shutdown, stop}` → 再拉起 hub；(b) 写 veto 后 kill -9 hub → 拉起；(c) live 记录发起删除，在停止梯中途 restart                | (a)(b)：spawnFn 0 次，记录为现状结局，veto 被消费；(c)：记录被删除（`agent_removed`），从不出现 `restore` 字段                                                                                                                                                                                                         |
| HR6 | **次数上限**：每次恢复回到 live 后立刻 kill -9 hub（稳定期未到），重复                                                                                                | 第 4 次 boot 时 `restore.failure:"exhausted"`，走现状回收；`attempts` 在盘上先于 fork 递增（读文件断言）                                                                                                                                                                                                               |
| HR7 | **双打与 pid 安全**：hub 与 reaper 均存活时 kill -9 hub，fake `--ignore-eof --ignore-term`；新 hub 在旧 reaper grace（5s）内启动；另一轮把盘上旧身份的 starttime 改错 | 旧进程被结束、新进程存活且从未收到信号（fake 把收到的信号写 stderr）；starttime 改错那一轮：不对该 pid 发任何信号（核验失败），`probeIdentity` 判 confirmed（pid 已被复用的语义）⇒ 正常 fork                                                                                                                           |

### 12.3 conformance（`tests/conformance/rpc-spawn.test.ts`，真实 pi，临时 HOME）

| #   | 用例                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR1 | `pi --mode rpc --session <绝对路径>`：会话文件用真实 pi 生成（先起一个 rpc pi，经 `prompt` 以外的方式让它落盘有困难时，用 pi 包导出的 `SessionManager` 写出一条 user 消息；两种方式择一，以 pi 1.0.x 可行者为准）；断言 hello 后的 session 帧 `sessionId` 等于文件 header 的 id、`sessionFile` 等于该路径；stdout 全部是 JSON 行（无 readline 提问）；stdin EOF 后 8s 内退出 |
| CR2 | `pi --mode rpc --session-id <新 id>`（本项目无此会话）：session 帧 `sessionId` 等于该 id；stdout 无非 JSON 行；stderr 出现 pi 的 warning                                                                                                                                                                                                                                     |
| CR3 | `pi --mode rpc --session <不存在的绝对路径>`：进程**正常 live** 且是空会话（钉住 F22——这是 hub 必须自己 preflight 的原因；若 pi 将来改成报错退出，本用例失败提醒我们 preflight 可以简化）                                                                                                                                                                                    |

可选（有可用模型凭据时）：恢复后的模型等于会话里最后一次 `model_change`，而不是 pi 默认（钉住 D8）；SIGKILL 截断会话尾行后 `--session` 仍可打开（§6.6 风险）。

### 12.4 真机验收（追加到 `docs/dev/web-hub-spawn/acceptance.md` 的 S1 之后，新节「R：restore」）

R1 网页起两个会话、各聊一轮 → `/webhub restart` → 两张卡片回到 live，历史完整，模型未变；R2 `kill -9 <hub pid>`（TUI 在线）→ 自动拉起后恢复；R3 恢复中刷新浏览器 → 只看到 restoring 行、无重复卡片；R4 `/webhub stop` → `/webhub start` → 不恢复；R5 正在查看某会话详情时 restart → 详情页自动切到新卡片。

---

## 13. 兼容性与回滚

| 场景                                                 | 行为                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webHub.spawn.enabled=false`                         | 零影响：无 `config.spawn`，一切与现状逐字节一致                                                                                                                                                                                                   |
| `webHub.spawn.restore=false`                         | spawns.json 不写会话字段（逐字节一致）、关停一律 terminate、boot 不分流；唯一差异是 `HubSpawnConfig` 多一个 `restore:false` 键                                                                                                                    |
| 旧 hub → 新 hub（首次升级）                          | 旧文件无 `sessionId` ⇒ 无候选 ⇒ 这次重启按现状结束会话；之后的重启才恢复。写进 CHANGELOG                                                                                                                                                          |
| 新 hub → 旧 hub（回滚）                              | 新字段被旧 `isRecordShapeOk` 忽略（未知字段放行），持久化枚举未扩展、版本未 bump ⇒ 文件不会被判 corrupt；旧 hub 把 `stopping+restoreIntent`/`starting{restore}` 当普通非终态回收（有身份 ⇒ TERM→KILL，无身份 ⇒ 无信号）——与现状完全相同的安全结局 |
| 老 pi 拉起的新 hub（`HubConfig.spawn` 无 `restore`） | 视为 `false`（D18）                                                                                                                                                                                                                               |
| 只认 `ctl.v1` 的老 agent 发 `/webhub stop`           | 会发 `reason:"restart"`（F7）。新 hub 恒广告 `ctl.v2`，能发 stop 的 agent 都会选 ctl.v2；剩下的残余情形由 veto 文件兜住（老 agent 若连 veto 都不写，则其 stop 会被当作 restart——老版本 agent 本来就没有正确区分 stop，可接受）                    |
| 协议                                                 | 不升 `PROTO`，不新增 agent↔hub 帧；`SpawnRecordPublic.restore` 为可选追加字段；UI 与 hub 同包发布                                                                                                                                                 |
| 回滚开关                                             | 运行期：`webHub.spawn.restore=false` + `/reload` + `/webhub restart`（注意：这次 restart 由**旧** hub 的配置决定是否打标——想立即生效就用 `/webhub stop` 再 `start`）。代码回滚：直接回退，见上「新 hub → 旧 hub」                                 |

---

## 14. 风险与待确认

### 14.1 风险

| #   | 风险                                                          | 缓解                                                                                                                                                                              |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 大会话恢复时 pi 冷启动 + 加载超出注册期限                     | 恢复注册期限 `2×registerTimeoutS`（上限 240s）；acceptance 记录实测耗时                                                                                                           |
| R2  | SIGKILL 截断会话尾行                                          | 先 TERM 等 3s；CR 可选项验证 pi 对残缺尾行的容忍；属现有风险                                                                                                                      |
| R3  | 旧进程重连期间用户向旧卡片发 prompt                           | UI 禁用 `restore.prevAgentKey` 卡片的 composer；窗口 ≤5s                                                                                                                          |
| R4  | 恢复与用户新建抢 `SPAWN_STARTING_MAX`                         | 恢复中的记录占 starting 名额，用户可能短暂收到 `E_LIMIT{starting}`；可接受，文案已能解释                                                                                          |
| R5  | `sessionPersisted` 证据靠 status 事件，崩溃发生在第一轮结束前 | 此时文件已在（user 消息落盘即建文件）⇒ 走 `--session <path>` 正常恢复；证据只在「文件缺失」时起作用，缺证据的结局是 `--session-id` 建同 id 空会话——仅当用户在这一瞬间恰好删了文件 |
| R6  | 终端用户同时打开同一会话                                      | pi 无会话锁，hub 管不到（§7 残余风险）                                                                                                                                            |

### 14.2 用户确认（2026-10-07 全部拍板，与本文建议一致）

1. **`superseded`（插件升级引发的 hub 版本替换）也恢复**（D2 成立）：否则每次插件升级都会杀掉网页会话，体验上与 restart 等价。
2. **全新、从未 live 的 `starting` 记录不恢复、不重拉空会话**（D3 成立）：没有对话、首条消息无法重投。
3. `RESTORE_MAX_ATTEMPTS=3` / `RESTORE_STABLE_MS=2min` / `RESTORE_MIN_LIFETIME_MS=5min` 三个常量按本文值（不做成设置项，需要时再开）。
4. 不加额外的「崩溃后多久内才恢复」窗口：运行时限锚定 createdAt（默认 12h）已足够约束。
