# web-hub 韧性三联修复计划 v2（db 熔断 / fence 诊断 / supersede 启动-关闭门控）

v2：响应评审 `review:hub-resilience-plan`（run `r_344T7BME`）的打回意见（#1–#15，阻塞 #1–#3）全面重写 §1–§6；§7 为 v1 已定的用户裁定，原文保留；新增 §8 逐条处置表。仍是只读调研，未改动任何代码。

## 0. 背景不变量（不变）

- 零挂起：所有 timer `unref()`；所有等待有 deadline；不得引入无界重试/无界队列。
- 单例保证：`src/web-hub/hub/singleton.ts` 的 abstract-namespace 守护 + socket fence 仍是唯一的"谁是 hub"仲裁机制；v2 **不**在此基础上叠加新的仲裁逻辑（评审 #3：探针式二次仲裁本身不可靠，已整项移除，见 §2）。
- L1–L6（`spawn/**` 的孤儿收割/恢复不变量）虽然本计划仍不直接改 `spawn/**` 代码，但 close()/fence 的任何改动都必须经过含托管子进程的早关/错乱场景验证（评审 #12）。
- `hub.json`/`hub.sock`/`start.lock` 写者仍唯一（`hub-json.ts` sealed writer）；v2 不再新增 `hub.json` 字段（评审 #5）。

---

## 1. Bug A — LAN auth DB 子进程熔断不可逆

### 证据（同 v1，复核无误）

`hub.log.1:4534-4556`（05:46–05:51 reparied deadline→giving up）；`db-client.ts:28-32,131-186,321-324`（4 次窗口内失败即 `notifyUnavailable()`，无回退路径，`admit()` 此后恒拒）；`lan-assembly.ts:60-68`（`onUnavailable`→`onStatus(off)`）；`http.ts:2500-2604`（`lanFacade.close()` 设永久 `lanClosed=true`，其后 `start()` 恒为 no-op，注释原文"close 之后的 start 为 no-op...唯一恢复路径是整进程重启"）；`http.ts:1205-1216`（`touchSession` 失败即 503，不登出——现状已对，不是缺陷）。

### 根因（修正）

1. 2s 单次 deadline 未考虑整机过载下子进程被调度延迟（而非死锁）也会撞线；#15 指出"自适应/双计数器"口径不清——改为单一、更大的**实测固定值**。
2. `db-client.ts` 的"4 次即永久放弃"与 `http.ts` 的 `lanFacade.close()` 是**两层终态**叠加：即使 db-client 本身可恢复，`http.ts` 也已经把监听器/订阅/SSE 永久拆除且自锁 `start()`——评审 #1 指出这是本 bug 的真正阻塞点，v1 只修了 db-client 层，没碰 http 层，恢复链路实际打不通。
3. #6/#7：v1 的"deadline 类 vs exit 类双计数器 + 冷却探针"没有统一的状态边界，退避定时器可能并发、重试上界不收敛，`reservedQueue` 本就没有长度上限。
4. #8：直接把 `onRecovered` 写成 `onStatus(on)` 会无视正在进行的 token/密码 rotate、无视"坏 DB"与"进程被饿死"的区别（`SELECT 1` 证明不了认证表可用）。

### 设计 v2

- **D-A1 单一实测固定 deadline**：`DEFAULT_DEADLINE_MS` 从 2000 上调到一个**更大的固定值**（本计划给出 8000 作为起点，合并前必须用新增的负载集成测试实测校准，不建立配置项/不做自适应算法——对齐 §7 裁定 2 与评审 #15）。
- **D-A2 单一 closed/open/probing 熔断状态机**（`db-client.ts` 内部重构，替换 v1 的双计数器+冷却探针设计）：
  - `closed`：正常路径，唯一 resident child；一次 op 撞 deadline 或 child 异常退出，统一计入**同一个**失败计数（不再区分 deadline/exit 两类），达到阈值（复用现有 `maxRestartsInWindow`/`restartWindowMs` 语义）⇒ 转 `open`。
  - `open`：`admit()` 对**所有**普通调用立即拒绝（复用现有 `unavailable` 标志，但不再是终态标志，而是"`state !== closed`"的别名）；**唯一**一个退避重试定时器（不新开定时器树）按封顶指数序列（复用 `DEFAULT_BACKOFF_MS` 的封顶思路，顶到比如 30min）到期后转 `probing`。
  - `probing`：重新 `spawnChild()`（同一个 resident child 槽位，不是"探测子进程"另开一路）；child 就绪后发一次**只读认证 schema 健康检查**（见 D-A4，不是 `SELECT 1`）。失败/超时 ⇒ 回 `open`，退避值按同一序列继续增长（不清零，不是从头重来）；成功 ⇒ **不立即判定健康**，等待 `PROBE_CONFIRM_GAP_MS`（如 10s）后再做第二次健康检查，连续两次通过才转 `closed`、清空失败计数（评审 #6"仅持续健康后重置"）。
  - 全程：旧 child 被 `onDeadline()` SIGKILL 后，必须等到它的 `exit` 事件真正触发（已有监听器）才允许 `spawnChild()` 再次发生——用一个 `awaitingExit` 标志阻塞提前respawn，避免"已发 SIGKILL 但未结算"的子进程与新 child 并存、形成无界的在途 I/O 堆积（评审 #7 后半）。
- **D-A3 两条队列都要有界**：`reservedQueue` 新增显式容量上限（如 8，现状只有 `interactiveQueue` 的 `queueSlots` 生效）；`open`/`probing` 期间两条队列都不接受新调用（不是只不派发，是 `admit()` 入口直接拒绝，不占队列槽位）。
- **D-A4 可逆的 LAN suspend（区别于终态 close）**（`http.ts` 的 `lanFacade`，评审 #1 核心要求）：新增 `suspend(reason)` 方法，与现有 `close()` 共享"中止 in-flight start、`unsubscribeLanBus`、`lanSse.closeAll()`、清 inflight/timer、`await handle?.close()`"的全部步骤，但**不**置 `lanClosed=true`（只置新的 `suspended` 标记，仅用于可观测性，不影响任何门禁）。`start()` 的既有生成号（`startGen`）比对逻辑原样复用——`suspend()` 之后再调用一次 `start()` 就是"代际检查过的重建监听/订阅/定时器 + 按真实 bind 结果发布状态"，这正是 `start()` 已有设计,不需要新机制。`db-client` 新增 `onRecovered` 回调；`lan-assembly.ts` 把 `onUnavailable`→`lanFacade.suspend("db-unavailable")`，`onRecovered`→**先过 D-A5 的恢复闸门**，再 `lanFacade.start()`。
- **D-A5 恢复闸门（评审 #8）**：`onRecovered` 触发时，在调用 `start()` 前必须确认：① 没有进行中的 rotate-intent（复用 `hub.ts:1100` 的 `scanRotateIntent`/`rotateIntentFile` 状态，不新建机制，有 pending 则推迟到下一次 rotate 扫描周期或下一次 `probing→closed` 转换再试）；② 整个 hub 不在终态关闭中（`lanClosed`/外层 `closing !== undefined` 时永不调用 `start()`）；③ "坏 DB"类错误（`checkDbFiles`/`db.ts:238` 已有的文件级/schema 级检测，`LanOffReason` 的 `db-invalid`/`db-too-large` 分支）**不**进入本熔断的自动恢复路径——那是结构性错误，必须保持直接 off、人工介入，不得被本状态机的 probing 成功掩盖（避免"自动重新 migrate/换库"这类恢复捷径，评审 #8 明确禁止）。
- D-A4 的健康检查（D-A2 "probing" 引用的）：新增 `db-child.ts` 只读 op，核验认证表（`users`/`sessions`，具体以 `lan-store.ts` 迁移脚本已建表为准）存在且列结构匹配——不建表、不迁移、失败即按"坏 DB"处理（走 ③ 的不自动恢复分支，而不是回退到 `open` 继续重试）。

### 不变量

- `admit()` 在 `open`/`probing` 期间恒快速拒绝,不进入队列,不挂起。
- 所有新增 timer `unref()`；同一时刻至多一个 resident/probe child、至多一个退避定时器。
- `DbClientError` 的 code 枚举不变；`checkLanSession`/`requireLanSession` 对调用方的 503/401 语义不变。

### 测试计划

- 单元（`db-client.test.ts` 追加）：closed→open→probing→closed 全路径状态迁移；"仅 probing 成功一次不应转 closed，须等第二次确认"；"旧 child 未 exit 前不得 spawnChild()"；两条队列各自的容量上限；`open`/`probing` 期间 `admit()` 不占队列。
- 单元（`http.ts`/`lan-assembly.ts` 新增 `suspend/recover` 测试文件）：`suspend()` 不置 `lanClosed`，之后 `start()` 能重新 bind 并重建订阅/定时器；`suspend()` 与并发 `start()`/`close()` 的代际号竞态（复用现成 `startGen` 竞态测试风格）。
- 单元：恢复闸门 ①②③ 各自独立阻止 `start()` 被调用（rotate-pending、hub 终态关闭、db-invalid 三个场景各一条）。
- 集成（新增 `tests/integration/web-hub-lan-db-recovery.test.ts`，#12 要求覆盖）：真实子进程注入慢/挂死脚本触发状态机到 `open`，推进到 `probing` 并让健康检查通过，断言恢复后：**有效 cookie** 的新 SSE 连接可建立、**过期 cookie** 仍 401、**撤销 cookie** 仍 401（旧 SSE 在 suspend 时已被 `closeAll()`，恢复后不应被旧连接复活）。
- 集成（长时间负载）：慢 fs 注入下跑一段时间，断言 spawn 速率不超过退避下限、两条队列长度始终不超过各自上限（评审 #12 "prolonged-load spawn-count/queue bounds"）。

---

## 2. Bug B — socket fence 丢失，5.5 分钟无 hub（证据重新定性，范围收窄为诊断）

### 证据（订正）

`hub.log.1:4558-4559`：06:08:54.616 `socket fence lost {why:"io"}` → 06:08:54.937 `hub closing {reason:"fence"}`；06:14:26.503 新 hub 启动日志出现 **`"identity":"boot-mismatch"`**（`spawnId":"aqiLeAz3kmFfKoA6","state":"exited","endReason":"orphan"`）——这是 web-hub-spawn 的 `bootId+starttime+uid` 身份识别机制（AGENTS.md "Managed spawn"段）在检测到**内核 bootId 变化**时才会打的标记,是**系统发生了重启/崩溃**的直接证据,时间点正好落在 06:08–06:14 之间。用户也确认"系统崩溃过"。

### 根因（降级重定性，评审 #3 #4）

1. **v1 的"假阳性"归因（持续重负载下 lstat 连续 3 次超 5s）从"很可能的直接成因"降级为未证实的假设**——`why:"io"` 本身是个粗粒度的桶（涵盖 EIO/EACCES/部分 `PrivateDirError`），当时日志没有记录每次 strike 的具体错误码/耗时，无法区分"调度延迟导致 lstat 超时"与"磁盘/内核在重启前就已经出现 I/O 错误"。`boot-mismatch` 证据下，**系统崩溃/重启**是对"fence 丢失 + 5.5 分钟完全无 hub 活动 + 无第二个 hub 日志"这整个现象更简单、更直接的解释：机器重启期间，hub 进程、三个连接的 agent 进程全部不存在，自然没有任何自愈日志,直到用户手动重新拉起一个 pi。
2. v1 的 D-B1（"丢失前二次确认再退出"）经评审 #3 证实**结构性不可行**：abstract-namespace 守护 socket 通常只会连到"自己"（本进程仍持有，没释放前谁也连不出"另一个"身份）；`hub.sock` 这条路径本身没有"报身份/PID"的握手协议，强行复用 `askGuard` 需要新协议；"无回应"时继续循环等待可能让两个 hub 同时活一段时间，或者反而因为不肯退出而抢了合法 successor 的位置。**整项移除，不做任何改变退出判断的逻辑**。
3. v1 的 D-B2（agent 侧扩大"被动断开"→`noHub` 判定窗口）经评审 #11：既不能证明"hub 真的死了"（正常的 live 断线本来就 ~0.5s 后重连；更关键的是——同一套被饿死的事件循环会**同等延迟**这条新判定本身，并不能换来"30s 内必自愈"的硬保证），也会放大对着一个"活着但很慢"的 hub 抢着 spawn 的风险；多 agent 场景下 per-process 节流也挡不住群体效应。**整项移除**。
4. v1 的 D-B4（`buildHubConfig` 的 `home` 从 `deps.paths.stateDir` 反推）经评审 #9：`<home>/.pi/agent/web-hub` 去掉 `/web-hub` 得到 `<home>/.pi/agent`,而 agent 侧真正用来拼目录的是 `webHubStateDir(home) = <home>/.pi/agent/web-hub`——任意注入的 `HubPaths` 反推回 `home` 在数学上不是普遍可逆的（还要考虑 XDG/`/tmp` fallback 分支）。**不做反推**。

### 设计 v2（大幅收窄：诊断优先，不改仲裁/退出逻辑）

- **D-B-diag（唯一的行为级改动，纯增量日志，不改 `startFence` 的进出状态机）**：`singleton.ts` 的 `checkAsync()`/`noteIoStrike()` 每次 strike（包括最终触发 `onLost("io")` 的那次）都额外记录：错误的具体分类（`err instanceof PrivateDirError` 时的 `reason` 字段；否则 `errCode(err)` 的系统错误码，如 `EIO`/`EACCES`/`ETIMEDOUT`）、本次校验实际耗时（`withDeadline` 包裹前后的时间差,而不只是"超过 `checkDeadlineMs`"这一个布尔）、以及当前 in-flight 的文件系统校验数量（`inFlight` 标志已有，扩展为计数）。目的仅仅是"下次再发生时能从日志直接分辨出是过载假阳性还是真崩溃/真被顶替",**不改变** `fenceLossOf`/`lost()`/`onLost` 的任何判定或退出行为。
- **D-B-guard（测试沙箱守卫，评审 #10 条件保留，按新规格重做）**：
  - `REAL_HOME`/`REAL_AGENT_DIR` 基线在 `tests/setup/sandbox-home.ts` **模块顶层**求值（vitest `setupFiles` 在任何测试文件被 import 之前先加载并执行一次,此时间点早于任何测试可能对 `process.env.HOME` 的修改,满足"setup-module evaluation, independent of later HOME changes"）。
  - 守卫的是**真实的 `connect`/`listen`/`spawn` 调用**而不是字符串匹配提前拦：包一层 `node:net` 的 `connect`/`Server.prototype.listen`、`node:child_process` 的 `spawn`，当目标路径/`PI_WEBHUB_CONFIG.home` 解析后落在 `webHubStateDir(REAL_HOME)` 或其 XDG/`/tmp/pi-webhub-<realUid>` fallback 之一时记违规;违规**记录到模块级数组并立即在当次调用处 reject/throw**，同时 `afterEach` 断言数组为空,非空则让那条测试显式失败并打出违规调用栈(不是 console.error 静默提示)。
  - 提供 `withRealHomeAllowed(fn)` 逃生口（目前没有需要用到的测试,但为将来保留),仅测试态生效,从不被 `src/**` 引用。
  - 这是一项独立的测试基建加固,**与 Bug B 本次事故的根因无关联**,文档里明确写清楚这一点,避免被误读成"修复了 Bug B"。
- **D-B-launchHome（替代 v1 的 D-B4，评审 #9 选项一）**：不做路径反推,改为在 `WebHubDeps`/`wireWebHub` 新增一个**显式、可选**的 `launchHome` 字段;提供时,`buildHubConfig` 直接用它作为 `home`(跳过 `env.HOME ?? homedir()` 的计算),不提供时行为与现状**字节级不变**。需要"sandbox 了 `paths` 又要连带 sandbox spawn"的调用方(目前已知测试里没有,未来新增才需要)显式同时传 `paths` 与 `launchHome`,而不是指望框架从 `paths` 反推。

### 不变量

- `startFence`/`fenceLossOf`/`lost()` 的进入与退出条件（含所有确凿证据分支）**字节级不变**——v2 对 Bug B 不做任何仲裁/退出逻辑改动。
- D-B-guard 只在测试态生效，不改变任何生产路径可观察行为；`launchHome` 未设置时 `buildHubConfig` 行为不变。

### 测试计划

- 单元（`singleton-hardening.test.ts` 追加）：每次 strike 的诊断字段（错误分类/耗时/in-flight 计数）被正确记录到日志；**不**新增"不退出"分支的测试（因为行为未改，现状测试应继续原样通过，防止意外引入行为变化）。
- 单元（新 `tests/web-hub/agent/launch-home.test.ts`）：`launchHome` 提供时 `buildHubConfig().home` 使用它；不提供时与现状一致。
- 单元（新 `tests/setup/sandbox-home-guard.test.ts`）：验证守卫本身——模拟一次"忘记传 HOME"的 `net.connect`/`child_process.spawn` 调用，断言测试显式失败并带出调用栈；`withRealHomeAllowed` 逃生口正常放行。

---

## 3. Bug C — supersede 重启 TDZ + 版本乒乓（启动/关闭门控redesign）

### 证据（订正，评审 #14）

`hub.log.1`：pid 779625 于 03:51:34.279 `hub process starting`（不是"started"）；03:51:34.377 `web-hub http listening`；第二轮核对（§9）确认 `supersede restart failed`（TDZ `ReferenceError`）共 **8** 次。第一轮仅列出了 .388/.395/.396/.398/.402/.405/.407 七条，不能据此认定第 8 次成功；03:51:34.411 的 `hub started` 才是启动成功发布；.414 的 `hub closing {reason:"superseded"}` 是**开始关闭**，不是关闭完成（完成须看独立的 `hub closed` 日志）。已列失败窗口约 19ms（.388→.407），这约 20ms 的重试噪音与两轮乒乓之间观测到的 ~34s 间隔（03:51:34→03:52:08）**没有因果关系**；那 34s 由 agent 侧重连/退避节奏（`backoffDelay()`、`spawnThrottleMs`）决定，**不是** TDZ 重试的代价，v1"修复后缩短数十秒"的说法不成立，予以撤回。
`hub.ts:985`（`createSupersede(...)` 构造）早于 `hub.ts:1242`（`let closing`）；`restart()` 回调（`:1049-1083`）经 `close()` 读取 `closing`——只要某次 hello 触发的 `observe()→begin()→restart()` 发生在源码顺序执行到 `:1242` 之前（即 `fe.listen()`/agent-server 接受连接之后、到 "hub started" 日志语句之间的某个尚未 await 完的窗口）就会 TDZ。
`hub.ts:1076`：`registry.broadcast({t:"superseded", nextVersion, yieldMs: SUPERSEDE_YIELD_MS, ...})` **只存在于版本 supersede 的 `restart()` 回调里**；`admin.ts:244-246`（`handleShutdown`→`deps.shutdown(reason)`）的 `/webhub restart` 管理指令**完全没有**广播这个帧——这是"admin restart 之后新旧版本 agent 无协调地同时抢 spawn"的直接代码级证据。

### 根因

1. TDZ 是声明/初始化顺序问题，8 次失败是同一个 bug 的重复表现。
2. v1 的修复（只把 `let closing` 挪到函数顶部）**不完整**（评审 #2）：`close()` 函数体里还无条件引用了 `stopFence()`、`idle.stop()`、`clearInterval(tick)`、`clearInterval(rotateScan)` 这四个在源码顺序上声明/赋值更晚的绑定（其余如 `uploadInflightTick`/`previewRoutes`/`worktreeDiffRoutes`/`spawnSup` 等现状已经是 `!== undefined` 判空调用，本身是安全的）；只要早触发的 `close()` 跑到这四行中的任意一行，仍然会抛同类错误（TDZ 或"读 undefined 的方法"），且**启动流程本身不检查自己是否已经被要求关闭**——即便 `close()` 自己没抛错、跑完了整个 teardown，外层 `startHub` 仍可能继续往下执行到 `log.info("hub started")`/写 `hub.json`，对外发布一个"已关闭"的 hub 为"运行中"。
3. 版本乒乓是结构性的（旧 0.3.0 内存代码不可变），但"admin restart 无协调广播"这个口子是新侧可以补的：乒乓的"谁先抢到"目前是纯随机的,因为唯一的协调信号（`superseded` 帧 + `yieldUntil`）只在版本 supersede 场景触发,admin 重启场景完全没有触发它的机会。

### 设计 v2

- **D-C1 启动/关闭统一门控（替换 v1 的"只挪 `let closing`"，覆盖 supersede 与 admin shutdown 两条触发路径，评审 #2）**：
  1. 把 `close()` 会引用的**每一个**句柄（`stopFence`、`idle`、`tick`、`rotateScan`、`uploadInflightTick`、`uploadSweepTick`、`spawnSup`、`firstPromptFwd`、`spawnHistory`、`history`、`previewRoutes`、`worktreeDiffRoutes`、`worktreeGraphRoutes`、`runTx`、`runFileReader`、`agentServer`、`fe`、`uploads`、`owner`，以及 `closing`/`resolveClosed`/`closed`）的**声明**（不是赋值）一并提到 `startHub` 函数体最顶部，每个给出"close() 可以安全调用的默认值"：`stopFence`/`idle` 默认一个 no-op（`() => {}` / `{stop(){}}`），`tick`/`rotateScan`/`uploadInflightTick`/`uploadSweepTick` 默认 `undefined` 且 `close()` 里补上目前缺失的判空（现状只有后两个有判空，前两个是裸调用，这是本次必须修的两处裸调用点）。
  2. **关闭期间禁止发布启动成功**：在 `startHub` 走到"hub started"日志/`hub.json` 写入之前，检查 `closing !== undefined`（此时已安全可读）——若已经有一次早触发的 close 在进行/完成，**跳过**"hub started"发布与 `hub.json` 写入,直接 `await closing` 后让 `startHub` 以"已关闭"结果返回(新增一种返回形状,呼应现有的 `{exists:true}` 提前返回惯例),调用方（`main.ts`）据此直接干净退出,不残留一个对外宣称"running"但内部已经 teardown 完的进程。
  3. 这一套门控对 supersede 的 `restart()` 和 admin 的 `handleShutdown()`（都收敛到同一个 `close()` 入口）**一视同仁**,不需要分别处理两条触发路径。
- **D-C2 版本乒乓阻尼（放弃 hub.json 持久化标记，复用既有协议机制，评审 #5）**：
  - v1 的 `patchSupersedeHistory` 方案被评审 #5 证伪：`close()` 流程里 `hubJson.removeIfOurs()` 会删文件、writer 是 sealed-after-close,提前写同样会被删,未来时间戳/时钟回退/坏记录也没有定义——**整项放弃,不新增任何 `hub.json` 字段**。
  - 改为复用**已经存在**的协调机制：`connection.ts:616`（收到 `t:"superseded"` 帧时设置 `this.yieldUntil = higherOrEqual ? 0 : now + frame.yieldMs`）与 `connection.ts:754`（`maybeSpawn()` 的 `now >= this.yieldUntil` 门槛）、`supersede.ts` 的 `SUPERSEDE_YIELD_MS`——这套机制在"版本 supersede"场景下本来就是对的,只是在"admin 触发的 `/webhub restart`"场景下从未被触发（`admin.ts:244-246` 直接 `deps.shutdown(reason)`,不广播任何帧）。新增：在 `admin.ts`/`hub.ts` 的 admin-shutdown 路径里，关闭前对 `registry.broadcast(...)` 一次 `{t:"superseded", nextVersion: info.version, yieldMs: SUPERSEDE_YIELD_MS}`（`nextVersion` 填**自身当前版本**，语义从"即将替换为更新版本"弱化为"重启后，版本号 ≥ 此值的 agent 优先重连，其余短暂让行"）——**不新增协议字段/帧类型**，只是多一个发送调用点。
  - **边界必须写清楚、不能承诺消除**：此设计只对"两端都认识 `superseded` 帧语义"的 agent 有效；`superseded`/`yieldMs` 字段早于本次改动已经存在于协议里,0.3.0 是否也遵守相同语义**无法仅凭读码确认**,需要在实现阶段用两个不同版本的真实构建产物互测验证（这是本计划明确标注的未决假设,不是既成事实）。对于真的运行着不认识此帧的更旧 agent,乒乓**不会被消除**,只会在轮到"两端都新"的那部分 agent 时被显著抑制；D-C1 修 TDZ 带来的收益仅限于"第一次 hello 触发的 supersede 不再有约 20ms 的失败重试噪音、且不会在罕见情况下因为重试耗尽时间预算而彻底失败",**不承诺**缩短两轮乒乓之间数十秒量级的间隔（那由 agent 侧 backoff/节流决定,本计划不改）。

### 不变量

- `SupersedeController`（`observe/tick/dispose`）签名/状态机语义不变。
- 单例守卫（`acquireGuard`/`askGuard`）"同一时刻只有一个 hub 赢得 bind"不受影响；D-C1/D-C2 都不改变这条不变量,只改变"谁先被允许发布成功"和"谁更倾向于暂缓抢"。
- `hub.json` 不新增字段，继续走现有 sealed-writer 规则。

### 测试计划

- 单元（新 `tests/web-hub/hub/hub-startup-gate.test.ts`）：构造"close() 在 `tick`/`rotateScan`/`stopFence`/`idle` 赋值之前就被调用"的场景,逐一断言不抛错；"已关闭"场景下启动流程不再写 `hub.json`、不记"hub started"。
- 集成（新 `tests/integration/web-hub-supersede-early-close.test.ts`，评审 #12 要求用真实路径 + 更高版本 agent）：真实 `startHub()`,用一个可控的慢 `lanAssembly.build()`/`fsDeps` 制造启动期窗口,在该窗口内让一个**真实的、版本号更高的**（而不是伪造字段的）agent 通过真实 socket 连接发 hello,断言：supersede 一次性成功,不抛 TDZ,且启动流程本身不会在 close 之后继续发布"运行中"状态。这条测试同时验证 D-C1 的 2、3 两点。
- 单元（`connection.test.ts` 追加）：admin-shutdown 广播 `superseded` 帧后,低版本 agent 的 `yieldUntil` 按预期设置,`maybeSpawn()` 在窗口内不触发。
- 单元（`hub.test.ts`/`admin.test.ts` 追加）：admin `handleShutdown` 路径在关闭前确有一次 `registry.broadcast({t:"superseded",...})` 调用（回归锁定,防止未来重构漏掉）。

### 补充测试：跨域验收矩阵（评审 #12，覆盖 Bug A/B/C 共享的启动-关闭语义与 spawn 子系统）

以上三个 bug 的集成测试之外，新增一个独立的集成测试包（见 §4 P-Int），覆盖：

1. **two-serving-hub**：构造一次不完整关闭，断言 D-C1 的"关闭期间禁止发布启动成功"确实杜绝了两个 hub 同时自认为"运行中"。
2. **silent-successor**：successor 绑定了 socket 但之后无任何后续活动（模拟半启动的替代者），断言前任的 close()/shutdown 不会因此挂起或误判成功。
3. **re-arm/close race**：fence 触发的 close 与 supersede 触发的 close 并发，断言 `close()` 的既有幂等守卫（`if (closing !== undefined) return closing`）在 D-C1 重构后依然只执行一次 teardown。
4. **managed-child L6**：早触发 close 时若已有一个托管 spawn 处于 `restore:intent`，`spawnSup.shutdown()` 的 L6（"老身份死亡未确认前绝不 fork"）不得被 close 的新句柄初始化顺序破坏。
5. **journal-ownership**：同上场景下 workflow/journal 状态不被重复释放、不悬空。
6. 见 §1 测试计划的 LAN 有效/过期/撤销 cookie + SSE 恢复场景（同一个集成包里跑，复用同一套起停基础设施）。
7. 见 §1 测试计划的长时间负载 spawn 次数/队列上限场景。

---

## 4. 包拆分与文件归属（v2：串行，针对 P2 落地后的代码基线）

**前提（评审 #13）**：仓库当前有一个未提交的 in-flight 功能（worktree-graph plan v2，下称 P2）正在修改 `src/web-hub/hub/{ports,http,hub,audit}.ts` 与 `hub/worktree-diff/{git,membership,routes}.ts`（为 `hub.ts` 的 `startHub` 新增 `worktreeGraphRoutes` 的构造/cleanup-push/close 三处插入点）。P2 会先于本计划提交。本计划的 P-C（动 `hub.ts` 启动/关闭结构最深）、P-A（动 `http.ts` 的 `lanFacade`）都与 P2 的改动区**同文件**，因此 v2 改为完全串行、显式按序提交，且明确与 P2 不重叠的归属区：

| 顺序 | 包               | 范围           | 独占/主要文件                                                                                                                                                                                                         | 与 P2 的关系                                                                                                                                      |
| ---- | ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | （前置，外部）P2 | worktree-graph | `hub/{ports,http,hub,audit}.ts`、`hub/worktree-diff/*`、`hub/worktree-graph/*`                                                                                                                                        | 先于本计划合并到 master，本计划从其之后的 commit 拉分支                                                                                           |
| 1    | **P-C**          | Bug C          | `hub.ts`（`startHub` 顶部句柄提升、"关闭后不发布"门控、admin-shutdown 广播 `superseded` 帧）、`admin.ts`（广播调用点）、新测试文件                                                                                    | 在 P2 落地后的 `hub.ts` 基础上做；`worktreeGraphRoutes` 的 cleanup-push/close 三处属于"每个 close() 引用的句柄"之一，一并纳入 D-C1 的句柄提升清单 |
| 2    | **P-A**          | Bug A          | `db-client.ts`、`db-child.ts`（健康检查 op）、`lan-store.ts`、`lan-assembly.ts`、`http.ts`（`lanFacade.suspend()`，与 P2 在 `http.ts` 的改动区不重叠——P2 只动 wtgraph 的 LAN-cap 门禁，需在实现前重新 diff 一次确认） | 依赖 P-C 落地后的 `hub.ts`/`close()` 结构（`onRecovered`→`lanFacade.start()` 的调用时机要避开门控窗口）                                           |
| 3    | **P-B**          | Bug B          | `singleton.ts`（诊断日志）、`agent/index.ts`（新增 `launchHome` 字段）、`tests/setup/sandbox-home.ts`、`vitest.config.ts`                                                                                             | 与 P-C/P-A 文件不重叠，可在 P2 落地后随时并行开发，但建议仍按 P-C→P-A→P-B 顺序提交以降低 review 负担                                              |
| 4    | **P-Int**        | 跨域验收       | §3 末尾"补充测试"列出的新集成测试文件                                                                                                                                                                                 | 依赖 P-C+P-A+P-B 全部落地                                                                                                                         |

---

## 5. 风险

- **D-A2（单一熔断状态机）**：`probing` 的两次健康检查确认间隔（`PROBE_CONFIRM_GAP_MS`）设太短可能对"刚恢复但还不稳定"的 DB 误判健康；设太长会拖长 LAN 恢复时间——需要在 P-A 的负载集成测试里实测调参，不承诺首版数字就是最终值。
- **D-A5（恢复闸门）**：rotate-pending 检查依赖现有 `scanRotateIntent` 的轮询周期（`ROTATE_SCAN_MS`），恢复可能因此延后最多一个周期——可接受,但要在文档/日志里体现"恢复被 rotate 阻塞"这一状态,避免运维误以为卡死。
- **D-C1（句柄提升）**：遗漏任何一个 `close()` 引用的句柄都会让"修复不完整"的问题复现（正是本轮被打回的原因）——`tests/web-hub/hub/hub-startup-gate.test.ts` 必须对 `close()` 函数体做一次穷举式核对（逐行走查其引用的每个自由变量），而不是只测已知的几个。
- **D-C2（admin-shutdown 广播 superseded 帧）**：如果某个真实存在的旧版本 agent 对 `yieldMs`/`forced` 等字段的处理与当前假设不一致（协议字段虽然存在但语义曾变过），广播反而可能引入新的异常分支——必须先用两个真实历史版本的构建产物做兼容性探测（不只是读源码推断），这是实现阶段的硬性前置步骤,不是可选项。
- **D-B-guard**：monkeypatch `net`/`child_process` 的颗粒度若过粗可能误伤合法用例;需要在引入后跑一次全量测试套件确认零误伤,再合并。
- **包排序（P-C→P-A→P-B→P-Int）**：若 P2 在本计划开发期间又发生后续修改（P2 自身也可能分多次提交),P-C 开工前必须重新确认 `hub.ts` 的最新基线,而不是只看本计划写下的这一份 diff 快照。

## 6. 给用户的开放问题（v2，替换 v1 对应条目）

1. D-A1 的 8000ms 起始 deadline、`PROBE_CONFIRM_GAP_MS`=10s、退避封顶等数字目前都是"覆盖本次极端负载场景"的经验起点，按 §7 裁定 2 不开放设置项、先写死——是否同意把"合并前必须跑一次真实负载集成测试重新校准这些常量"列为 P-A 的强制验收项（而不是现在就在评审里敲定最终数字）？
2. D-C2 的 admin-shutdown 广播 `superseded` 帧需要用两个真实历史版本（如当前 0.3.0/0.4.0 的实际构建产物）做兼容性探测——是否已有可用的旧版本构建产物/环境,还是需要先从 git 历史里单独构建出来做这个探测？
3. Bug B 现在定性为"系统崩溃/重启导致",不再是 web-hub 自身的逻辑缺陷——是否需要在本计划之外另开一个"机器稳定性/监控"任务跟进（例如引入 bootId 变化告警),而不是继续算在 web-hub 韧性范围内？

## 7. 用户裁定（2026-10-10，v1 已定，原文保留）

1. Bug B 主修复 = D-B1（fence 丢失先二次确认再退出，CPU 过载误判为主因）；D-B2（agent 侧 noHub 检测缺口）、D-B3/D-B4（测试 HOME 沙箱 + `buildHubConfig` 路径覆盖）作为加固项同包一起做。
2. 所有阈值（db deadline、冷却、`HUB_PRESUMED_DEAD_MS`、supersede 冷却窗口）先写死常量，不新增设置项；真机验收后再决定是否开放。
3. 本轮不接入飞书通知；D-C2d（`/webhub restart` 广播 suppress_spawn）不做。

> 说明（v2 附注，不改写上面的原文裁定）：裁定 1 中点名的 D-B1/D-B2/D-B3/D-B4 在 v2 里分别被：D-B1 整项移除（评审 #3，见 §2）、D-B2 整项移除（评审 #11，见 §2）、D-B3 按评审 #10 重新设计为 D-B-guard（见 §2）、D-B4 按评审 #9 替换为 D-B-launchHome（见 §2）。裁定 2"阈值先写死不开放设置项"在 v2 中继续适用（D-A1/D-A2 的所有数字均为写死常量）。裁定 3 不受影响。

## 8. 评审处置表（`review:hub-resilience-plan` run `r_344T7BME`，#1–#15 全部采纳）

| #   | 严重度 | 一句话问题                                                                                                                                    | 处置                         | v2 对应设计                                                                              |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | 阻塞   | LAN 熔断恢复后 `http.ts` 层仍终态 close，`start()` 恒 no-op，恢复是假状态                                                                     | 采纳，重新设计               | D-A4（可逆 `suspend()`/`start()`，代际号复用既有 `startGen`）                            |
| 2   | 阻塞   | TDZ 修复不完整：`stopFence`/`idle`/`tick`/`rotateScan` 等句柄早关仍会抛错；关闭后启动流程仍可能继续发布"运行中"                               | 采纳，重新设计               | D-C1（全句柄提升 + 关闭期间禁止发布启动成功，覆盖 supersede 与 admin shutdown）          |
| 3   | 阻塞   | fence "io" 丢失前的二次确认探针无法仲裁 split-brain（abstract guard 只认自己、`hub.sock` 无身份协议、无回应可能无限等待或误抢合法 successor） | 采纳，整项移除               | §2：不做任何仲裁/退出逻辑改动，仅保留诊断日志 D-B-diag                                   |
| 4   | 严重   | CPU 过载根因未证实；`boot-mismatch` 提示其实是系统重启                                                                                        | 采纳，重新定性               | §2 证据/根因改写为"系统崩溃是更可能的解释，CPU 过载降级为未证实假设"                     |
| 5   | 严重   | `hub.json` 冷却标记写不进去（sealed writer + close 删文件）                                                                                   | 采纳，整项放弃，改用既有机制 | D-C2（复用 `superseded`/`yieldUntil`，扩展到 admin-shutdown 路径）                       |
| 6   | 严重   | 熔断重试边界未定义，双计数器口径不清，ping 成功即清零不代表持续健康                                                                           | 采纳，重新设计               | D-A2（单一 closed/open/probing 状态机，两次确认才转 closed）                             |
| 7   | 严重   | backoff 期间仍可能绕过队列上限；reserved 队列无上限；deadline 超时不取消底层 I/O，respawn 可能与未结算的旧 child 并存                         | 采纳                         | D-A2（awaitingExit 门槛）+ D-A3（两条队列显式上限 + open/probing 期间 admit() 直接拒绝） |
| 8   | 严重   | 恢复直接写 LAN-on 可能覆盖 rotate-pending；`SELECT 1` 不证明认证 schema 可用                                                                  | 采纳                         | D-A5（rotate-pending/终态关闭/坏 DB 三道闸门）+ 只读 schema 健康检查                     |
| 9   | 严重   | `buildHubConfig` 的 home 反推数学上不成立（去掉 `/web-hub` 得到的不是合法 home，且未验证 XDG/tmp fallback）                                   | 采纳，改用显式覆盖           | D-B-launchHome（新增可选 `launchHome` 字段，不做反推）                                   |
| 10  | 严重   | 全局 HOME 沙箱守卫的基线捕获时机过晚、未覆盖真实 connect/listen/spawn、生产态误用风险、失败被静默吞掉                                         | 采纳，按规格重新设计         | D-B-guard（setup 模块顶层求值基线、守卫真实操作、显式测试失败、测试态逃生口）            |
| 11  | 严重   | D-B2 既不能证明"hub 真的死了"，也给不出承诺的 30s 硬上界，且会在 hub 活着但慢时误触发 spawn                                                   | 采纳，整项移除               | §2：不做任何改变 `noHub`/`maybeSpawn` 判定窗口的改动                                     |
| 12  | 严重   | 验收计划遗漏跨域危险场景（fence 牵动 spawn 子系统的 L1–L6、supersede 测试用不存在的"更高版本"字段伪造而非真实更高版本 agent）                 | 采纳                         | §3 末尾"跨域验收矩阵"七项 + 真实更高版本 agent 的早关集成测试                            |
| 13  | 严重   | 包"相互独立"的前提不成立：P-A 必须动 `http.ts`，且另一功能 P2 已在改 `hub/{ports,http,hub,audit}.ts`                                          | 采纳，重新规划               | §4（完全串行：P2 → P-C → P-A → P-B → P-Int，显式文件归属表）                             |
| 14  | 一般   | Bug C 的03:51:34.279 不是完成态；第二轮核对确认 8 次失败；closing 不等于 closed；30s 乒乓间隔与 TDZ 重试代价无因果关系                        | 采纳，更正                   | §3 证据段重写，删除"修复后缩短数十秒"的结论                                              |
| 15  | 建议   | D-A1 的"自适应"缺算法、与"写死常量"的用户裁定冲突，双计数器/磁盘阻尼收益未经测量                                                              | 采纳                         | D-A1（单一更大的实测固定 deadline，不做自适应/不新增设置项，对齐 §7 裁定 2）             |

## 9. 第二轮评审分诊与用户裁定（2026-10-10，主会话收敛规则）

第二轮评审（gpt-6.1-sol）仍打回：剩余问题集中在「LAN 可逆恢复」生命周期（#1 #3 #4 #5）与启动/关闭闸门细节（#2 #6 #7）。按 dev-flow 两轮打回收敛规则由主会话分诊：

- **Bug A 改道（用户裁定）**：放弃 LAN 可逆恢复（D-A 的 reversible suspension / reopen / rotate 协作全部删除）。改为：db-client breaker 进入 open 并冷却（常量，建议 60 s）后，hub **复用现有 admin restart 路径自我优雅重启**（等同 `/webhub restart`：reason `restart`，agent 重连拉起新 hub，托管会话走既有 restore；不新增任何恢复语义）。
  - 频率上限：每小时最多 2 次自重启；计数持久化在 `<stateDir>/self-restart.json`（≤4 条时间戳、写入 0600、有限数值校验；读失败/损坏/时钟回拨 ⇒ **视为已达上限，不重启**，即 fail-safe 为「保持现状」）；超限 ⇒ 维持今天的行为（LAN 关闭、日志 + `/webhub status` 可见原因），等人处理。
  - 固定 deadline 常量调大（按 v2 的标定值）、breaker 单状态机/单重试定时器/拒绝期间不放行（评审 #4 的边界）仍保留——它们决定何时触发自重启；坏 DB（#5）由重启上限兜底，不得在恢复路径里创建/迁移替代 DB。
  - 自重启前若有 open dialog / 在途命令，沿用 supersede/restart 既有的 drain 语义，不另起。
- **Bug C 按 v2 施工**，评审 #2 #6 #7 作为开发包**必须满足的验收项**：`supersedeWaitCancels`/`supersedeTimer`/`unsubscribeSupersedeOnDialogs` 等全部 close() 依赖在暴露前初始化（TDZ 不能靠 `!== undefined` 守卫）；启动中每个产生资源的 await 点与 close 协作（迟到结果清理）；`identityFields()` 先 await 完再进同步发布闸门；`main.ts` 处理新的 closed 结果分支；supersede TDZ 测试在 supersede 注册之后阻塞 `fe.ui.refresh()`，admin shutdown 测试用更早的 assembly 窗口；L6 断言 = 旧子进程死亡确认前 successor 不 restore fork；日志引用修正为 8 次失败、区分 closing/closed。
- **Bug B 按 v2 施工**（仅诊断日志 + 测试沙箱守卫 + 显式 launchHome）。
- 施工顺序：等 worktree-graph P2 提交后串行：P-C（启动/关闭闸门）→ P-A'（breaker + 自重启）→ P-B（诊断 + 沙箱）。每包验收模型 ≠ 开发模型。
