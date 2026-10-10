# web-hub 韧性三联修复计划（db 熔断永久放弃 / fence 误判 5.5min 断连 / supersede TDZ + 版本乒乓）

只读调研产出，未改动任何代码。证据来自 `~/.pi/agent/web-hub/{hub.log,hub.log.1}`（JSON 行）与源码。

## 0. 背景不变量（必须保持）

- 零挂起：所有 timer `unref()`，所有等待有 deadline；修复不得引入新的无界 await/无界重试。
- 单例保证：`src/web-hub/hub/singleton.ts` 的 abstract-namespace 守护 + socket fence 仍是唯一的"谁是 hub"仲裁机制；三个 bug 的修复都不绕过它。
- L1–L6（web-hub-spawn/restore 的 spawn 识别/孤儿收割不变量）与本计划无交集，不触碰 `src/web-hub/hub/spawn/**`。
- `hub.json`/`hub.sock`/`start.lock` 的写者仍然唯一（`hub-json.ts` "sealed writer"）。

---

## 1. Bug A — LAN auth DB 子进程「永久放弃」

### 证据

- `hub.log.1:4534-4556`：05:46–05:51 期间反复 `db-client: query op deadline exceeded, killing subprocess {op:"touchSession"}` → `lan http: touchSession failed`（503）→ 05:51:01.530 `db-client: giving up after repeated crashes {failures:4,windowMs:600000}`。05:56 之后仍是同样的 `touchSession failed`（`unavailable` 之后 `admit()` 直接拒绝，见下）。
- `src/web-hub/hub/db-client.ts:28-32`：`DEFAULT_DEADLINE_MS=2_000`、`DEFAULT_BACKOFF_MS=[1000,5000,30000]`、`DEFAULT_RESTART_WINDOW_MS=10min`、`DEFAULT_MAX_RESTARTS_IN_WINDOW=4`。
- `db-client.ts:152-186`（`onChildDown`）：每次子进程退出/被 deadline 杀死都计入 `restartFailureTimestamps`；达到 4 次即 `log.error("giving up after repeated crashes")` + `notifyUnavailable()`（`:182-186`），**没有任何代码路径再把 `unavailable` 置回 `false`**——只有 `close()`（整个 hub 进程关闭）才会重置状态，这是一次性、不可逆的熔断。
- `db-client.ts:321-324`（`admit()`）：`unavailable===true` 时直接 `reject(E_DB)`，连子进程都不会再尝试拉起。
- `src/web-hub/hub/lan-assembly.ts:60-68`：`store.onUnavailable(() => onStatus({state:"off",reason:"db-unavailable"}))`——LAN 整体被标记 off，需要重启 hub 进程才能恢复。
- `src/web-hub/hub/http.ts:1205-1216`（`requireLanSession`）：`touchSession` 失败只会 503 `E_DB`，**不会 401/登出**；`recheckLanSseExpiry`（`http.ts:1082-1090`）同样只记日志、保留连接。即"瞬时失败不登出用户"这条已经是现状，不是本次要修的缺陷。

### 根因

1. 2s 的单次 op deadline 是针对"正常负载"校准的，没有考虑整机 CPU 过载（当时有多个全量 vitest 套件在跑）场景下 **子进程被操作系统调度延迟**（而非真正死锁）也会撞线。
2. 撞线后的处理是"直接 SIGKILL + 计入失败窗口"，4 次之内的失败窗口（10min）在持续过载下很容易在 ~5min 内打满。
3. `notifyUnavailable()` 是单向门：没有冷却后重试（probe）机制，必须重启整个 hub 进程才能恢复 LAN，这与别处"永不永久放弃、永远留一个恢复路径"的项目惯例（如 `src/bash/deadline.ts` 的 grace/extend）不一致。

### 设计

- **D-A1 自适应/可配置 deadline**：`DbClientDeps` 新增 `deadlineMs` 的 settings 透传（`webHub.lan.db.deadlineMs`，默认仍 2000，但允许运维调大；参考 `lan-store.ts:79-90` 已有的 `dbClient` overrides 接口，只需要在 `lan-assembly.ts:52` 的 `createLanStore({...})` 调用里把 `cfg` 中新字段映射进 `dbClient:{...}`）。同时引入"失败原因区分"：`onDeadline`（`db-client.ts:260-280`）命中时记录 `cause:"deadline"`；子进程异常退出（非 deadline 触发的 kill）记录 `cause:"exit"`；仅 `exit` 类失败计入"硬故障"计数，`deadline` 类失败走独立的、更宽容的计数器（见 D-A2）——避免把"机器太忙所以慢"和"进程真的崩了"混为一谈。
- **D-A2 冷却后退避重试，取消永久放弃**：`notifyUnavailable()`（`db-client.ts:131-139`）改名语义为"进入 degraded"，不再是终态。新增 `scheduleCooldownRetry()`：进入 degraded 后，用**翻倍上限封顶、unref 的**定时器（如 30s→2min→10min→30min 封顶，参考 `src/bash/deadline.ts` 的 grace 设计手法）周期性尝试 `spawnChild()` 并发一次零成本探针 query（如 `SELECT 1` 或等价的 `ping` op，需要 `db-child.ts` 新增一个只读 op）；探针成功 ⇒ 清空 `restartFailureTimestamps`、把 `unavailable` 置回 `false`、触发 `onRecovered` 回调（`lan-assembly.ts` 订阅后把 `onStatus({state:"on"})` 写回，与 `patchLan` 现有机制对称）。探针失败 ⇒ 维持 degraded，冷却时间翻倍（封顶）。整个过程全程 `unref()`，不阻塞 hub 退出。
- **D-A3 不改变"瞬时失败不登出"现状**，只在文档/测试里把这一行为钉死（见测试计划），防止未来重构不小心改成 401。

### 不变量

- `admit()` 在 degraded 期间仍然快速 reject（不排队、不挂起）——保持现状的"fail fast"语义，只是 degraded 不再是终态。
- 所有新增 timer `unref()`；冷却重试不占用 `interactiveSlots`/`queueSlots`（用独立的探针调用，`reserved:true` 或单独通道）。
- `DbClientError` 的 code 枚举不变（`E_BUSY`/`E_DB`/`E_RATE`），避免影响 `http.ts` 现有的错误映射。

### 测试计划

- 单元（`tests/web-hub/hub/db-client.test.ts`，已存在，追加用例）：
  - `deadline 类失败不应与 exit 类失败共享同一熔断计数`（4 次 deadline 失败不应触发 `giving up`，或触发的是更宽容的阈值）。
  - `进入 degraded 后，探针成功应清空计数并恢复 call() 可用`（fake timer 推进冷却周期）。
  - `degraded 期间 admit() 仍快速 reject，不进入队列`。
  - 回归锁定现状：`touchSession 失败返回 E_DB 而不是让会话失效`（已有行为，新增一条显式测试防止回归）。
- 集成（新增 `tests/integration/web-hub-lan-db-recovery.test.ts`）：真实子进程、人为制造 4 次 deadline（用一个会 sleep 超过 deadline 的测试脚本注入 `buildQueryScript({test:true})` 的变体），断言 LAN 在冷却周期后自动恢复（`hub.json.lan.state` 从 `off` 变回 `on`，走真实 HTTP 503→200 的状态转换），全程不超过测试自定的短冷却配置（不用等 30min 真实值）。

---

## 2. Bug B — socket fence 误判丢失，5.5 分钟无 hub

### 证据

- `hub.log.1:4558-4559`：06:08:54.616 `socket fence lost: another hub owns the socket path {why:"io"}` → 06:08:54.937 `hub closing {reason:"fence"}`。此后到 06:14:26.446 `hub process starting`（由一个 pi 重启触发）之间，日志里**没有任何第二个 hub 的 "hub process starting/hub started/hub already running" 记录**——即从未真的有另一个 hub 进程存在过。
- `src/web-hub/hub/singleton.ts:106-111`：fence 周期 30s（`DEFAULT_FENCE_MS`）、首检 2s、单次校验 deadline 5s（`DEFAULT_FENCE_CHECK_DEADLINE_MS`）、`io` 类错误需连续 3 次（`DEFAULT_FENCE_IO_STRIKES`）才触发 `onLost("io")`。
- `singleton.ts:396-416`（`fenceLossOf`）：`"io"` 专指"校验本身超时/非 `PrivateDirError` 的 I/O 错误"，**不是**"看到了一个不同的 owner"（那是 `"socket-replaced"`/`"dir-replaced"`，要求 lstat 成功且 identity 不同）。换句话说，`why:"io"` 在语义上就是"连续 3 次没能在 5s 内问出答案"，而不是"确认了别人占着"。
- 时间关联：Bug A 的 DB 熔断发生在 05:46–05:51（同一台机器、同一时间段"几个 agent 在跑全量 vitest"），06:08 的 fence 误判与之同属一次持续重负载窗口——lstat 系统调用在 CPU 严重争用下连续 3 次超过 5s 预算是完全合理的假阳性来源，且日志里**没有第二个 hub 存在过**这一事实直接排斥"真的被别的 hub 顶替"的解释。
- 测试侧排查：全仓库搜索 `tests/**` 下调用 `wireWebHub`/`startHub`/`resolveHubPaths` 的用例（`tests/web-hub/agent/wiring*.test.ts`、`tests/integration/web-hub-control.test.ts` 等）均显式传入 `env:{HOME: tmp.dir}` 或 `paths: resolveHubPaths({home: sandboxHome})`，且唯一直接传 `paths` 覆盖而不传 `env.HOME` 的用例（`tests/integration/web-hub-control.test.ts:241,681`）同时显式 `autoStart:false`，当前不会触发真实 spawn。**没有发现本次事故的直接测试元凶**，但发现一个独立的潜在陷阱（见下）。
- **潜在陷阱（与本次事故无法确认关联，但本身是真实设计缺陷）**：`src/web-hub/agent/index.ts:296`（`const home = env.HOME ?? homedir()`）只用于默认 `paths`（`:299-304`），但 `buildHubConfig`（`:922-934`，被 `:1001` 和 `:1343` 的 `spawnHub(...)` 调用使用）**无条件使用同一个 `home` 变量**，完全不管调用方是否显式传了 `deps.paths` 覆盖。也就是说：一个测试即使小心地给 in-process 连接传了沙箱 `paths`，只要没有**同时**覆盖 `env.HOME`、且没有 mock `spawnImpl`、且触发了自动拉起，就会用**真实 homedir** 拼出 `HubConfig.home` 丢给 `spawnHub()`，真的 fork 出一个绑定到真实 `~/.pi/agent/web-hub/hub.sock` 的 detached 进程。当前测试套件里没有同时踩中这三个条件的用例，但没有任何机制阻止未来新增的测试踩中它。

### 根因（两个互相独立、都要堵上的口子）

1. **fence 误判口（本次事故最可能的直接成因）**：`startFence` 把"连续 3 次验证超时"直接等同于"确认被顶替"，在持续重负载下这是假阳性；而"confirmed loss ⇒ 立即退出"这条反应又太激进——退出之后完全没有"先确认真的有人活着再让位"的二次校验。
2. **测试隔离口（独立缺陷，待排除未来复现同类事故的可能性）**：
   a. 没有全局 vitest 沙箱守卫，任何新测试文件只要忘记显式设置 `env.HOME`/`paths`，就可能在进程内对真实路径发起 `net.connect`。
   b. `wireWebHub` 的 `buildHubConfig` 与 `deps.paths` 可以互相矛盾（home 来自 `env`，paths 可以来自别处），这是刻意覆盖 `paths` 的调用方会掉进去的坑。
3. **agent 侧 5.5 分钟没有自愈（放大器，即便 fence 本身修好也该堵）**：`src/web-hub/agent/connection.ts:731-744`（`linkDownAfterTeardown`）只有 `connectCode` 是 `"ENOENT"`/`"ECONNREFUSED"`（即"连接尝试本身失败"）时才置位 `noHub` 并考虑 `maybeSpawn()`（`:746-778`）；一个**已经 live 的链接被服务端关闭**（`close("fence")` 走到 `agentServer`/底层 socket 关闭，对端只会先收到一次普通的 `close`/`error`，teardown 时 `connectCode` 是 `undefined`，见 `:731` 的入参注释"only set when the failure happened before the socket connected"）**第一次 teardown 根本不进入 noHub 判断**，而是走最朴素的指数退避（`backoffDelay()`，`:785-790`，0.5s→30s 封顶）。按设计文档（`docs/dev/web-hub/arch.md:313`）此处应该"~30s 自愈"，但如果连接的 3 个 agent 进程自己的事件循环也被同一波重负载饿死（定时器被延后触发），退避+重连+再次判定 noHub 的整条链路都会被相应拉长——这与 Bug A 发生在同一窗口期是一致的解释：**不是设计上的 bug，而是"假设定时器能按时触发"这条前提在极端负载下失效后，没有兜底**。

### 设计

- **D-B1 fence "io" 丢失前二次确认，不再无条件自杀**（`singleton.ts` + `hub.ts:1299-1301`）：`startFence` 的 `onLost` 回调在 `why==="io"` 时，不直接 `close("fence")`，而是先做一次**主动存活确认**：对着 `socketPath` 发起一次短超时（如 1–2s）的 `net.connect` + 复用 `askGuard`-类的"报出 pid/身份"协议（或直接走 abstract-namespace 守护 socket 的现成探测逻辑，`singleton.ts:564-610` 的 `askGuard`）。
  - 确认结果 = "有其他活着的、身份不同的 hub 在应答" ⇒ 维持现状，立即 `close("fence")`（真·让位，这是唯一该退出的分支）。
  - 确认结果 = "连不上/无应答/依旧超时" ⇒ **不退出**：记一条 warn 日志（标注"io fence loss treated as transient, re-arming"），重置 `ioStrikeCount`，让下一轮 30s 周期检查继续；只有在 `fenceLossOf` 返回 `"socket-replaced"`/`"dir-replaced"`/`"socket-missing"`（lstat **成功**但身份确实不同，或路径确实被删）等有确凿证据的分支才保留"立即退出"的既有语义——这些分支不受本次改动影响。
  - 可选加固：`DEFAULT_FENCE_CHECK_DEADLINE_MS`/`DEFAULT_FENCE_IO_STRIKES` 也可配置化（`webHub.fence.checkDeadlineMs`/`ioStrikes`），给长期重负载的机器一个手动调宽的口子，和 D-A1 对称。
- **D-B2 agent 侧缩小"连接被动断开"与"连接失败"之间的空档**（`connection.ts`）：在 `teardownSocket`/`linkDownAfterTeardown` 路径上增加"hub presumed dead"判定：记录 `hubMissingSince`（首次 teardown 时间戳，无论 `connectCode` 是否存在）；每次 `linkDownAfterTeardown` 都检查 `now - hubMissingSince >= HUB_PRESUMED_DEAD_MS`（新常量，建议与 `TIMING.spawnThrottleMs` 对齐，30s）——满足则无论 `connectCode` 是什么都把 `noHub` 置真、送入 `maybeSpawn()` 判定；一旦某次 `connectNow()` 真正恢复 live，清空 `hubMissingSince`。这样即使第一次 teardown 因为是"被动断开"而错过了 noHub 窗口，最多一个 `spawnThrottleMs` 周期后也会自我纠正，不依赖后续连接尝试恰好拿到 ENOENT。
- **D-B3 全局 vitest HOME/agent-dir 沙箱守卫**（新文件，纯测试基础设施，不动生产代码）：
  - 新增 `tests/setup/sandbox-home.ts`，在 `vitest.config.ts` 加 `test.setupFiles`。
  - 做法：`beforeAll` 读取真实 `os.homedir()`/`process.env.HOME` 存一份只读基线；`beforeEach` 不强行覆盖 `process.env.HOME`（会破坏现有大量显式传参的用例），而是**打补丁拦截** `node:net` 的 `connect`/`createServer`（或更精确：包一层 `fs`/`net` 的 spy，仅在"目标路径以真实 `<realHome>/.pi/agent/web-hub` 开头"时抛错并 `console.error` 打印调用栈）——任何测试（包括未来新增的）一旦在进程内尝试触碰真实 agent 目录，测试立刻失败并指出是哪一行代码触发的,而不是静默地真的建立连接或真的 fork 进程。
  - 同时给 `spawnHub`（`launcher.ts:99-116`）的默认 `spawnImpl` 加一层同类守卫：当 `config.home` 等于真实 homedir 时直接拒绝/报错（而不是真的 `child_process.spawn`）——这是对 D-B1 之外"测试把生产用户的真实 hub 带崩"这类事故的第二层兜底，即使某个新测试忘记注入 `spawnImpl` mock 也不会真的 fork。
- **D-B4 消除 `buildHubConfig` 与 `deps.paths` 的home 不一致**（`index.ts:296-304` vs `:922-934`）：当 `deps.paths` 被显式传入时，`buildHubConfig` 的 `home` 改为从 `deps.paths.stateDir` 反推（去掉 `/web-hub` 后缀）而不是继续用 `env.HOME ?? homedir()`；没有 `deps.paths` 覆盖时行为不变。这样"调用方显式沙箱化了 paths"这个意图会被这条链路尊重，而不是在 spawn 分支悄悄用回真实路径。

### 不变量

- `startFence` 对确凿证据分支（`socket-replaced`/`dir-replaced`/`socket-missing`/`owner-mismatch`/`socket-symlink`/`socket-not-socket`）的"立即退出"语义完全不变——D-B1 只收窄 `"io"` 这一个本就模糊的桶。
- 二次确认探测本身也要有界超时（不超过原 `checkDeadlineMs`），不能把"假阳性"换成"挂起"。
- D-B2 不改变 `backoffDelay()`/`spawnThrottleMs` 的限流语义，只是让"认定 noHub"这件事更快发生，仍然尊重每进程 30s 一次的拉起节流，不会制造 thundering herd（叠加 D-C 部分的单例守卫兜底）。
- D-B3/D-B4 是测试与宿主隔离加固，不改变任何生产路径的可观察行为（`deps.paths` 未覆盖时字节级不变）。

### 测试计划

- 单元（`tests/web-hub/hub/singleton-hardening.test.ts`，已存在同类用例，追加）：
  - `"io" 丢失在探测到无应答时不应 close，只应重置 strike 并继续下一轮`。
  - `"io" 丢失在探测到另一个身份不同、确实存活的 holder 时应立即 close("fence")`（回归锁定真·让位路径不被破坏）。
  - `socket-replaced/dir-replaced/socket-missing 等确凿分支行为字节不变`（防回归）。
- 单元（`tests/web-hub/agent/connection.test.ts`，新增用例）：
  - `活跃链接被动断开（connectCode undefined）在 HUB_PRESUMED_DEAD_MS 后应转入 noHub/maybeSpawn 判定`（fake timer）。
  - `连接及时恢复应清空 hubMissingSince，不触发多余 spawn`。
- 集成：
  - `tests/web-hub/hub/singleton-hardening.test.ts` 或新文件 `tests/web-hub/hub/fence-false-positive.test.ts`：用可注入的慢 `lstat`（模拟 CPU 过载）构造连续 3 次超时但 socket 实际未变的场景，断言 hub **不退出**。
  - 新增 `tests/web-hub/agent/sandbox-home-guard.test.ts`：验证 D-B3 的守卫能在"忘记传 env.HOME"的场景下快速失败并给出清晰报错（即为守卫本身写测试）。
  - `tests/web-hub/agent/wiring-spawn.test.ts` 追加一条：`deps.paths 覆盖时，buildHubConfig().home 应与 paths.stateDir 一致，即使 env.HOME 指向别处`。

---

## 3. Bug C — supersede 重启 TDZ + 版本乒乓

### 证据

- `hub.log.1:505-534`：2026-10-09 03:51:34.279 新 hub（pid 779625）刚 `hub started`（`:505` 之前几行），03:51:34.388 起连续 **8 次** `web-hub: supersede restart failed {error:"ReferenceError: Cannot access 'closing' before initialization"}`（`:506,509,512,514,519,524,528,530`），直到 waitedMs:32 那次才真正 `hub closing {reason:"superseded"}`（`:535`）成功。
- `src/web-hub/hub/hub.ts:985`：`supersede = createSupersede({...})` 构造时机，早于：
- `hub.ts:1242`：`let closing: Promise<void> | undefined;`（TDZ 绑定声明点）。
- `hub.ts:1049-1083`：`restart: async ({...}) => { ...; await close("superseded"); }`——`close`（函数声明，整段作用域内被提升/可调用）内部在 `:1322` 左右 `if (closing !== undefined) return closing;` 读取 `closing`。只要某个 agent 的 `hello`（经 `supersede.observe()`）在**源码顺序上尚未执行到 `:1242` 的 `let closing;` 语句**之前触发了 `restart→close()`，就会命中 TDZ `ReferenceError`——这与证据中"hub 刚 started 11ms 就开始报错，报错 8 次后才成功"完全吻合（`startHub` 内部还有若干 `await`，事件循环把 microtask 排到 `:1242` 执行之前，期间到达的 hello 都会触发同一个 TDZ 坑；直到真正执行到 `:1242` 之后，`closing` 才变成一个"已初始化为 `undefined`"的合法绑定）。
- `hub.log.1:420-588`：完整时间线显示"版本乒乓"的机制——`/webhub restart`（`:483` `admin op...op:"shutdown"...reason:"restart"`）之后，仍然连着的 0.3.0 pi 进程（`a3196318`/`a2804318`/`a2805208`，日志里反复出现 `"version":"0.3.0"`）和 0.4.0 进程（`a778456`）**同时**在各自的 `connection.ts` 里判定 noHub 并发起 `spawnHub`（`hub.log.1:499-504` 四个 pid 几乎同时 `hub process starting`，其中三个 `hub already running, exiting`，单例守卫按预期工作，只有一个赢家）；但赢家由哪个 agent 的 0.3.0/0.4.0 在场版本决定——`:505` 的赢家最终以 `"version":"0.3.0"` 启动（`:536` `web-hub: ui root rejected...0.4.0 !== 0.3.0"` 和 `:548` `"hub started"...,"version":"0.3.0"` 可反推），说明**0.3.0 的旧进程内存里的插件代码完全不知道有 0.4.0 存在，只要它自己判定 noHub 就会去抢着拉起一个 0.3.0 的 hub**；随后 0.4.0 agent 的 hello 再把它 supersede 回 0.4.0——如此往复，`:571` 处 03:52:08 又发生一次同样的 0.3.0→0.4.0 轮回，直到 03:52:15 (`:588` 之后) 才稳定在 0.4.0。

### 根因

1. **TDZ 是纯粹的声明顺序 bug**：`let closing` 声明点在"它可能被读取"的时间点之后，8 次重试全部是同一个 bug 的重复表现，不是 8 个不同原因。
2. **版本乒乓是结构性的，不是 bug**：`shouldSpawnHub`/`maybeSpawn`（`connection.ts:746-778`，`launcher.ts:126-154`）完全不感知"集群里是否已经有更新版本的 hub 刚被取代过"，每个 agent 进程只基于自己内存里的 `pluginVersion` 和本地 `noHub`/节流状态独立决策；0.3.0 的旧进程**不可能**被修复（已经在内存里跑着旧代码），所以乒乓的"完全消除"在只有新代码可改的前提下是不可达的——只能做到"新版本一侧主动避让得更快/更果断"，把每轮乒乓的代价（当前观测：~34s 一轮，含 8 次 TDZ 失败重试的浪费）压到最低。

### 设计

- **D-C1 修复 TDZ（优先，收益最大且风险最小）**：把 `let closing`（连同它天然绑定的 `resolveClosed`/`closed` promise 三件套，`hub.ts:1238-1242`）**移到 `startHub` 函数体最顶部**（`rootScope`/`cleanup` 初始化之前，任何 `await`/HTTP 监听/agent-server 注册之前），确保在源码执行顺序上，`closing` 这个绑定在 `supersede = createSupersede(...)`（`:985`）甚至更早的任何可能触发 hello 处理的代码之前就已经完成初始化（`let closing: Promise<void> | undefined = undefined;`，显式初始值，避免未来再有人误以为"没有初始化表达式=安全"）。`function close(...)`/`resolveClosed` 的赋值保持原位，只搬运声明本身。这是纯粹的声明顺序修复，不改变任何运行时行为（除了消除 TDZ 崩溃）。
  - 回归测试：构造一个"supersede 在 `startHub` 的 promise 链尚未完全 resolve 时就被触发"的场景（用可控的假 `openDialogs`/`now`/`restart` 依赖在 `createSupersede` 构造后立刻同步调用 `observe()`），断言不再抛 `ReferenceError`，且只需要一次调用就能成功 close。
- **D-C2 版本乒乓阻尼（新侧单方面能做到的部分）**：
  - a) **D-C1 本身就是最大的阻尼**——修复后每一轮 supersede 从"至少 1 次 hello 到最终成功"不再需要 7 次失败重试，单轮乒乓的墙钟时间大幅缩短（从观测到的数十秒级降到 acc32-B9 handshake（≤1.5s，`supersede.ts:14-18` 的 `SUPERSEDE_DIALOGS_HANDSHAKE_MS`）+ drain 量级）。
  - b) **新增"近期被 supersede 过"冷却标记**：hub 在 `createSupersede` 的 `restart()` 回调成功完成后（`hub.ts:1083` 之后），把 `{minVersion, at}` 写入 `hub.json` 的一个新字段（`hubJson` 的 `write()`/`patchXxx` 家族新增 `patchSupersedeHistory`，与现有 `patchLan`/`patchUi`/`patchSpawn` 同构，见 `hub-json.ts:98-127`）。**只有新版本（具备这段逻辑）的 agent** 在 `maybeSpawn()`（`connection.ts:746`）判定 noHub 之前，先读一下这个标记：若 `minVersion` 新于自己的 `pluginVersion` 且 `now - at` 在一个短冷却窗口内（建议 `SUPERSEDE_COOLDOWN_MS`，覆盖"重启后的 thundering-herd 重连窗口"量级，如 15–20s），则**主动放弃本轮拉起**，继续走普通 backoff 等别人（更新的 agent）去拉；冷却窗口过后恢复正常判定（不会永久卡死，哪怕所有新版本 agent 都退出了，旧版本 agent 在冷却期满后仍然会按原逻辑拉起）。
  - c) 这条防御对 0.3.0 这类"已在内存里跑旧代码、不可能再读到新字段"的进程**无效**（已在任务里确认为不可达目标），但对"0.4.0 vs 将来某个 0.4.1"这类未来场景会显著降低乒乓概率，且对本次事故的直接改善来自 (a)。在 risks/open-questions 里明确写清楚这个边界。
  - d)（可选，不建议本轮做，列为备选）：`/webhub restart` 管理指令在真正关闭前，向所有已连接 agent 广播一个新的 `hub_ctl` 子类型帧（如 `suppress_spawn{ms}`），新版本 agent 收到后临时抬高自己的 `spawnThrottleMs`；旧版本 agent 读不懂新帧类型会直接忽略（协议向后兼容，`decodeHubFrame` 对未知类型的现有容错行为需要先确认，若当前就是"未知类型丢弃"则零风险）。本计划不在本轮实现，只记录为后续选项。

### 不变量

- `createSupersede`/`SupersedeController` 的对外状态机（`observe/tick/dispose`）签名与语义不变；D-C1 纯粹是外层 `hub.ts` 的声明顺序调整。
- 单例守卫（`acquireGuard`/`askGuard`）保证"同一时刻只有一个 hub 进程赢得 bind"这条不变量完全不受影响——乒乓问题从来不是"多个 hub 同时活着"，而是"连续多次短命 hub 交替存在"，D-C2 不改变这一点，只改变"谁更倾向于不去抢"。
- `hub.json` 新字段必须走现有 "sealed writer" 规则（`hub-json.ts:11` 附近注释），不能新开一条写路径绕过序列化。

### 测试计划

- 单元（`tests/web-hub/hub/supersede.test.ts`，已存在，追加）：
  - `restart() 回调在 close() 尚未进入可调用状态（closing 未初始化）时调用不应抛出`——用真实 `hub.ts` 的 `startHub` 片段很难单测到 TDZ 本身（这是宿主模块的词法作用域问题），所以这一条改为**源码静态检查测试**：新增 `tests/web-hub/hub/hub-source-order.test.ts`，解析 `hub.ts` 源文件文本，断言 `let closing` 的声明行号 **小于** `createSupersede(` 调用的行号（正则/简单字符串定位即可，不需要 AST），防止未来重构又把顺序颠倒回去。
- 集成（`tests/integration/web-hub-supersede-tdz.test.ts`，新增）：真实 `startHub` + 真实 HTTP/agent-server，故意让一个"旧版本" agent 在 `fe.listen()` 返回后用最短路径（不经过正常 `wireWebHub` 的节流）立刻发 hello，断言 supersede 的 `restart` 回调一次性成功、`hub closing {reason:"superseded"}` 只出现一次（不是 TDZ 失败 N 次后才成功）。
- 单元（`tests/web-hub/hub/hub-json.test.ts`，追加）：`patchSupersedeHistory` 写入/读回/与其他 patch 的合并语义。
- 单元（`tests/web-hub/agent/connection.test.ts`，追加）：`maybeSpawn() 在读到更新版本的冷却标记时应跳过本轮拉起，冷却期满后恢复`。

---

## 4. 包拆分与文件归属（互斥，便于并行开发/review）

| 包                                  | 范围  | 独占文件（新增/修改）                                                                                                                                                                                                                                                                                                                                                             | 依赖                                                                                                                                                              |
| ----------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P-A（db 韧性）**                  | Bug A | `src/web-hub/hub/db-client.ts`、`src/web-hub/hub/db-child.ts`（新增 ping op）、`src/web-hub/hub/lan-store.ts`（透传新 deps）、`src/web-hub/hub/lan-assembly.ts`（订阅 onRecovered）、`tests/web-hub/hub/db-client.test.ts`、新增 `tests/integration/web-hub-lan-db-recovery.test.ts`                                                                                              | 无（与 P-B/P-C 文件不重叠）                                                                                                                                       |
| **P-B（fence + 测试沙箱）**         | Bug B | `src/web-hub/hub/singleton.ts`（D-B1）、`src/web-hub/hub/hub.ts`（仅 `startFence` 调用处的 onLost 回调改线，D-B1 配套）、`src/web-hub/agent/connection.ts`（D-B2）、`src/web-hub/agent/index.ts`（D-B4，`buildHubConfig`）、新增 `tests/setup/sandbox-home.ts`、`vitest.config.ts`（加 setupFiles 一行）、`src/web-hub/agent/launcher.ts`（D-B3 的 spawnImpl 兜底）、相关测试文件 | 与 P-C 共享 `hub.ts`，但改动区域不重叠（P-B 只碰 `startFence` 调用处，P-C 只碰 supersede/close 声明顺序）——**建议 P-B 先合并**，P-C 基于其后版本 rebase，降低冲突 |
| **P-C（supersede TDZ + 乒乓阻尼）** | Bug C | `src/web-hub/hub/hub.ts`（D-C1 声明顺序、D-C2b 的 restart 成功回调里落盘）、`src/web-hub/hub/hub-json.ts`（新 patch 方法）、`src/web-hub/agent/connection.ts`（D-C2b 的读取标记逻辑——与 P-B 的 `connection.ts` 改动需要在同一个 PR 系列里按顺序合并，两边改的是不同函数：P-B 改 `linkDownAfterTeardown`，P-C 改 `maybeSpawn`，物理上不冲突但建议 P-B 先行）、相关测试文件         | 依赖 P-B 的 `connection.ts` 版本（文件级非重叠但同文件，建议顺序合并：P-A ∥ P-B，P-B 完成后再并入 P-C）                                                           |

并行策略：P-A 与 P-B 完全独立可并行；P-C 在 `connection.ts`/`hub.ts` 上与 P-B 有同文件、不同函数的改动，建议 P-B 先落地或两者在同一分支内按 P-B→P-C 顺序提交，避免合并冲突。

---

## 5. 风险

- **D-A2（冷却重试）**：如果底层 sqlite 文件真的损坏（而不是进程被饿死），冷却重试会周期性地重新尝试打开一个坏文件——需要确保 `db-child.ts` 对"文件损坏"类错误（区别于"进程被杀/超时"）仍然快速失败并保留一条**不重试**的硬错误通道（现有 `checkDbFiles`/`LanOffReason` 的 `db-invalid` 分支应继续直接 off，不走本次新增的冷却路径——需要在实现时明确区分"连接/子进程级"故障与"文件/数据级"故障，避免把后者也接上自动重试）。
- **D-B1（fence 二次确认）**：如果真的发生了"旧 hub 卡住但进程没死（僵尸但能应答）同时有新 hub 顶替"的边界情况，二次确认可能会读到旧进程仍然"活着"而错误地让位给一个实际上不该存在的新绑定者——但这和现有单例守卫（`acquireGuard`/`askGuard` 已经处理"activity vs 真死"）的既有语义一致，风险不高于现状。
- **D-B2（HUB_PRESUMED_DEAD_MS）**：如果设得太短，可能在正常的短暂网络抖动下也触发额外的 spawn 尝试（有 `spawnThrottleMs` 节流兜底，最坏情况多一次无效的 "hub already running, exiting"，不是挂起风险，但会有噪音日志）。
- **D-C2b（冷却标记）**：`hub.json` 新字段若被旧版本 agent 读到也不会出问题（忽略未知字段），但要确认 `hub-json.ts` 的 schema 校验不是"严格拒绝未知字段"模式（若是，需要先放宽）。
- **D-B3（测试沙箱）**：给 `net`/`fs`/`spawnImpl` 打补丁的实现如果颗粒度不对，可能误伤合法的、本来就该连接真实路径的个别测试（目前搜索没发现这类用例，但需要在实现阶段跑一次全量测试确认零误伤）。
- 三个包都涉及"长期观测性"缺口：目前 `hub.json`/日志里没有一个聚合视图能一眼看出"db 是否在 degraded 冷却中"“fence 最近一次是否误判过”“supersede 最近是否乒乓过”——建议后续（本计划之外）把这些状态并入 `/webhub status` 输出。

## 6. 给用户的开放问题

1. Bug B 的"测试误触真实路径"排查没有找到确凿的元凶测试（现有用例在 HOME/paths 覆盖上目前都算谨慎），而"fence 误判（CPU 过载下 lstat 连续超时）"这个假设与证据（日志里从未出现第二个 hub）吻合度更高——是否认可把 D-B1（二次确认再退出）作为本次事故的主修复，D-B3/D-B4 降级为"独立发现的加固项"一起做，而不是倒过来？
2. D-A1/D-B1 的具体阈值（deadline、冷却时长、`HUB_PRESUMED_DEAD_MS`、supersede 冷却窗口）目前都是按"覆盖本次观测到的极端负载场景"估的经验值，需要用户确认是否要暴露成 settings（增加配置面）还是先写死常量、后续真机验收后再决定是否开放配置。
3. D-C2d（`/webhub restart` 广播 suppress_spawn 帧）本轮明确不做，只记录为备选——是否需要排进后续计划，还是认为 D-C1+D-C2b 已经足够？
4. 是否需要把"db degraded / fence io-miss / supersede 乒乓"这三类事件也接入现有的 Feishu/通知通道（`src/feishu-notify/`），让运维在真实发生时能第一时间感知，而不是事后翻日志？

## 7. 用户裁定（2026-10-10）

1. Bug B 主修复 = D-B1（fence 丢失先二次确认再退出，CPU 过载误判为主因）；D-B2（agent 侧 noHub 检测缺口）、D-B3/D-B4（测试 HOME 沙箱 + `buildHubConfig` 路径覆盖）作为加固项同包一起做。
2. 所有阈值（db deadline、冷却、`HUB_PRESUMED_DEAD_MS`、supersede 冷却窗口）先写死常量，不新增设置项；真机验收后再决定是否开放。
3. 本轮不接入飞书通知；D-C2d（`/webhub restart` 广播 suppress_spawn）不做。
