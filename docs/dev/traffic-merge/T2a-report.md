# traffic 合并 T2a 报告：进程容器、生命周期与惰性加载

> 依据：`docs/dev/traffic-merge/plan.md` r3 中的 §0、§1、§3.1、§3.3、§4.1、§5.2、§6、§8.2 #3/#4/#10/#12/#13、§10 T2a 行，以及 §R1/§R2 里 R1-3、R1-8 和附带的 secure 条目。
> 基线：T1 `7d2a9ce4`。**本次没有 commit**（遵守纪律）。按方案拟用的提交标题是 `refactor(traffic): owned process engine and a single fetch trampoline`。
> 本包**不接线**：没有改 `src/index.ts`、settings 或任何现有模块，`git grep -n "traffic/" -- src ':!src/traffic'` 结果为空。

## 1. 改动文件

**源码（src/traffic/）**

| 文件           | 性质 | 要点                                                                                                                                                                                                                                                                          |
| -------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container.ts` | 新增 | 进程级容器 `Symbol.for("pi-subagent:traffic")`，内含 `{v, epochSeq, tap?, engine?}`。提供 `peek`（不创建）、`ensure`、`nextEpoch`                                                                                                                                             |
| `engine.ts`    | 新增 | `TrafficEngine` 带 owner、epoch 和 `state: open/closing/closed`。原先散在各模块的变量全部收进 engine。提供 `createTrafficEngine`、`acquireEngine`、`releaseEngine`、`peekEngine` 和 `close()`                                                                                 |
| `tap.ts`       | 新增 | fetch trampoline：每次安装新建闭包，下游固定；身份判活；退役后透传；ALS 重入守卫；tap lost；票据头在所有路径上都剥离                                                                                                                                                          |
| `persist.ts`   | 新增 | 唯一落库闸口 `persist(engine, epoch, op)` / `persistAllowed`。写之前复查 secure、`state==="open"` 和纪元；拒绝时计数，secure 时把 engine 推进 closing                                                                                                                         |
| `mode.ts`      | 新增 | `serviceAllowed(role, mode)` 只对「host ∧ tui/rpc」放行，未知 mode 一律拒绝（fail closed）。另有 `TrafficModeError`（`E_REPLAY_MODE`）和 `PRINT_MODE_NOTE`                                                                                                                    |
| `cancel.ts`    | 新增 | engine 级取消域（只触发、不等待；abortAll 之后再登记的条目立即被中止）。另有 unref 截止定时器、空闲定时器，以及 `REPLAY_DEADLINES`（60s / 120s / 30min）                                                                                                                      |
| `secure.ts`    | 改   | `isSecure() = PI_SECURE_SESSION==="1" ∨ getSecureDomain()?.kind ≠ plain`，**直接 import** `src/secure/domain.ts`。保留旧名 `isSecureSession`                                                                                                                                  |
| `db.ts`        | 改   | `loadSqlite()` 改为惰性，失败时抛 `SqliteUnavailableError`。新增 `defaultRecordPaths()`（调用时计算）和 `detectLegacyLayout` / `LegacyLayoutError`；**删除** `migrateLegacyRecordDir`。`ensureDb(engine)` 不会在 engine 关闭后重新开库。`upsertSession(db, ctx)` 改成接收连接 |
| `page.ts`      | 改   | 模块顶层零 IO。`buildPage()` 返回 `{html, gzip}`，由 server 在首个 `GET /` 时组装，缓存到 `engine.page`                                                                                                                                                                       |
| `jq.ts`        | 改   | 改为 `createJqRunner()`，每个 engine 一个；状态收进闭包。exit 监听在**首次 spawn** 时登记，`dispose()` 时移除。dispose 是终态，`reset` 不能让它复活                                                                                                                           |
| `rewrite.ts`   | 改   | `applyRequest(..., env: RewriteEnv)` 由调用方注入 jq 执行器和告警出口；去掉了对 sse 的依赖                                                                                                                                                                                    |
| `sse.ts`       | 改   | `broadcast(owner, event)`，客户端集合归 engine                                                                                                                                                                                                                                |
| `serialize.ts` | 改   | 改为 `createGate(engine)`，模块级闸门状态收进闭包。**闸门按方案在 T2b 退役**                                                                                                                                                                                                  |
| `correlate.ts` | 改   | 改为 `createCorrelator(engine, gate)`；`makeProbe`、`urlMatchesBase`、`respKeyOf` 仍是纯函数导出                                                                                                                                                                              |
| `capture.ts`   | 改   | 改为 `createCapture(engine)`。不再自行 patch，改由 trampoline 调用 `handleFetch(next, input, init, ticket)`。所有写走 persist；流捕获登记进取消域，每批都复查闸口，并支持 idle/signal 取消                                                                                    |
| `server.ts`    | 改   | 改为 `createTrafficServer(engine)`，提供 `startServer/accessUrls/handleHttp/replay`。加了模式门禁、连接账本、重放取消域与截止、四个切点复查，写走 persist                                                                                                                     |
| `state.ts`     | 改   | 只保留类型和常量，**删除** `state` 单例和 `resetState`                                                                                                                                                                                                                        |
| `index.ts`     | 重写 | 新增 `wireTraffic(pi, opts)`、`wireTrafficHost`、`wireTrafficChild`，**opts 缺省就是关**                                                                                                                                                                                      |

**测试**：13 个迁入文件全部改成按 engine 构造，断言语义不变。新增的文件如下：

- 夹具：`tests/traffic/helpers/engine.ts`、`tests/traffic/fixtures/lifecycle-child.ts`
- 新测试组：`tests/traffic/{engine,tap,mode-gate,db-path,legacy-dir}.test.ts`
- 扩充：`secure.test.ts`（+4）、`jq.test.ts`（+1）
- 集成：`tests/integration/traffic-lifecycle-process.test.ts`

## 2. 状态机

### 2.1 容器

- **创建时机**：只在 `/record on` 时经 `acquireEngine` 创建，这是首次显式 DB 访问。
- **不创建的情况**：`/record status` 在没有 engine 时只开一个短连接，读完计数就关；子会话钩子、`enabled=false`、只读查询也都用 `peek`，不创建容器。
- **生命周期**：容器建好后不删除，因为纪元必须单调；engine 和 tap 关闭后各自从容器里清掉。

### 2.2 Engine

```
            acquireEngine(owner)             close(reason)：同步段                     异步段（有界 closeBoundMs=1s）
  (无) ──────────────────────────▶ open ─────────────────────────────▶ closing ───────────────────────────────▶ closed
        g.engine 缺省 ⇒ 新建 epoch=++seq      recording=false · retireTap · cancel.abortAll      等 server.close（≤1s）→ db.close()
        同 owner ∧ open ⇒ 复用                gate.drain · corr.reset · SSE end+清空
        不同 owner（陈旧）⇒ 先 close 再新建   server 置空 · 逐个 socket.destroy · closeAllConnections
        同 owner 但已关闭 ⇒ 新建              jq.dispose（SIGKILL + 移除 exit 监听）
```

- **release**：只有满足 `g.engine === engine && engine.owner === owner` 才清空。旧激活迟到的 `session_shutdown` 不会清掉新实例，有测试覆盖。
- **close 幂等**：重复调用返回同一个 promise。close 之后 `ensureDb` 抛错（不能重开旧库），`persist` 丢弃写并计数 `droppedPersists`。
- **续体固定 engine**：钩子、fetch、重放、流捕获都在入口固定 engine 引用和纪元。await 之后不再读 `g.engine`；写一律经 `persist`，或在 server 内经 `writable()` 重新取连接。capture 里 `recordPreSend` 原先会跨 await 持有 `d`，已改为 await 之后再走 persist。
- **session_shutdown（host，任何 reason）**：先做身份校验的 `releaseEngine`，再 `await engine.close()`。

### 2.3 Trampoline

| 当前                                       | 事件                                 | 结果                                                                               | 测试（tap.test）                   |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------- |
| 无活动 wrapper                             | `/record on`                         | 新建 w，`next` 取当时的全局，设为全局，`activeId=w.id`                             | 行 1                               |
| 同 engine 已有活动 w                       | `/record on`                         | 幂等，返回 w                                                                       | 每次安装新闭包                     |
| 别的 engine 的活动 w                       | 安装                                 | 先退役旧 w，保证至多一个活动 wrapper                                               | 每次安装新闭包                     |
| 活动 w 且全局就是 w                        | engine 关闭                          | 全局还原为 `w.next`，w 退役                                                        | 行 2                               |
| 活动 w 且全局不是 w（被第三方包住）        | engine 关闭                          | 全局不动；w 退役为纯透传，只剥票据，不录                                           | 行 3                               |
| w 已退役，F（持有 w）被挂回全局            | `/record on`                         | 新建 w′（next=F），链为 w′→F→w→N，各调用一次，只录一次，F 收不到票据               | 行 4                               |
| 任意                                       | 下游通过延迟绑定再次调到同一个活动 w | 重入守卫改走 `nativeFetch`，`tapReentry++`，日志只记一次                           | 行 5                               |
| 任意                                       | 响应到达时活动 w 从未见过该票据      | tap lost：停录、退役、notify 一次、status 显示 `tap lost`；`/record on` 重装后恢复 | 行 6（经 `checkTapAfterResponse`） |
| 活动 w，但 engine 停录、关闭或处于加密会话 | 请求                                 | 剥票据后透传，不调用处理器                                                         | 票据头恒剥离                       |

## 3. 模式门禁（§4.1）

- **服务可用性在创建时固定**：`engine.serviceAllowed = serviceAllowed(role, ctx.mode)`，在 `/record on` 那一刻按 `ctx.mode` 决定。
- **print / json**：只录制，回复里注明「print 模式不启动网页服务」。不会创建 server，`engine.web` 为 null，`connections` 为 0。即便有人自行构造服务实例，`startServer()` 和 `replay()` 也会抛 `E_REPLAY_MODE`；HTTP 重放入口同样会先检查，命中时回 403 并带上 code。
- **子会话**：`wireTraffic({role:"child"})` 只注册 5 个录制钩子，没有命令、`session_start` 或 `session_shutdown`。子会话角色的 engine 永远不允许服务或重放。
- **tui / rpc**：启动 listener。每个 accepted socket 都 `unref()` 并记入账本；监听句柄本身也 `unref()`。
- **真进程验证**：print 配置下录制 3 个请求后，不调 shutdown，事件循环也能自然以 0 退出（集成测试的对照组）。

## 4. 惰性加载证据（§3.1 / §7.1）

**真子进程**：`tests/integration/traffic-lifecycle-process.test.ts` 的「traffic off」用例，使用临时 HOME。子进程 import 入口后，分别以缺省参数、`{enabled:false}`、`{enabled:false, role:"child"}` 调用 `wireTraffic`，断言如下：

- `stderr` 不出现 `ExperimentalWarning|SQLite`；
- `process.moduleLoadList` 里没有 sqlite（import 后和 wire 后都检查）；
- 三次调用都返回 `undefined`，注册调用 0 次；
- wire 期间 14 个 fs API 被 spy（经 `syncBuiltinESMExports` 同步到 ESM 绑定）：调用 0 次；
- 没有新增全局符号；`exit` 监听增量为 0（import 后和 wire 后都检查）；`globalThis.fetch` 不变；
- HOME 目录仍为空（没有 `.pi`）。

为了排除一个干扰项，快照之前先读一次 `Headers`：Node 第一次访问 `Headers/Request/Response` 时会自己挂上 `undici.globalDispatcher` 符号，那不是 traffic 的状态。

**对照组**：在 `enabled` + print 模式下执行 `/record on` 之前 sqlite 未加载，之后已加载，且 `ExperimentalWarning` 恰好出现 1 次。这说明上面的检测手段在真加载时确实能检测到。

**单测侧**：

- `jq.test`：创建执行器时不登记 exit 监听，首次 spawn 才登记，dispose 后移除。
- `engine.test`：close 同步移除 exit 监听。
- `db-path.test`：`loadSqlite` 失败时只有本命令失败，提示 Node ≥22.13，不留下 engine 或 wrapper，也不建库。

## 5. 与方案的偏离和说明

1. **serialize.ts 还在。** 方案 §10 把闸门退役划给 T2b。T1 报告曾写「T2a 删除」，这里以方案为准。T2a 只把它的模块级状态收进 engine（`createGate`）。correlate 同理，T2b 会用票据取代它。
2. **capture/correlate/serialize/server/jq 全部改成每 engine 一个的工厂函数。** 这是满足「无 module-scope 可变状态」和「原各模块级变量全部收入 engine」的必要做法。迁入的 160 个测试因此改为按 engine 构造（方案 §8.1 允许），断言语义不变。db.test 里两个 legacy 用例只改了说明文字。
3. **turn 计数从进程单槽改为每次激活的闭包变量**，子会话不会再覆盖主会话的 turn。这是顺手修掉的一个跨会话串值问题。
4. **`/record off` 不退役 wrapper。** wrapper 保持安装，靠 `recording=false` 纯透传；退役只在 engine close 或 tap lost 时发生。方案的转换表只规定了 close 时的行为，这样也避免反复 on/off 导致套层。
5. **监听句柄也 `unref()` 了**（方案原文只要求 accepted socket unref），这样 print/quit 时不会被拖住。
6. **`applyRequest` 新增必填参数 `env: RewriteEnv`**，为的是去掉 rewrite 对 jq/sse 模块单例的依赖。
7. **页面资源目录没动**：仍是模块同级的 `app.js` 和 `vendor/`，T1 的布局。方案 §2.1 里的 `web/` 子目录不在 T2a 范围。
8. **`busy_timeout` 仍为 5000，`BIND_HOST` 仍为 `0.0.0.0`。** 前者按 §3.2 由 T2b 连同写后账本改为 0，后者由 T4 改为 `traffic.web.host`。
9. **secure 依赖（需要注意）**：`src/traffic/secure.ts` 直接 import 了 `src/secure/domain.ts`，这是任务和 §6 的要求。但该文件目前**未被跟踪**（secure P2 在别处开发中）。**T2a 必须在 secure P2 提交之后、或与它一起提交**，否则干净 checkout 的 typecheck 会失败。
10. **#12 的测试按方案文件名拆成 `db-path.test.ts` 和 `legacy-dir.test.ts`，secure 的用例扩进已有的 `secure.test.ts`。**

## 6. 留给 T2b / T3 / T4 的接口

- **T2b**
  - `TapHandler = (next, input, init, ticket)`：wrapper 已经剥离票据并把票据值单独传入；可用 `TICKET_HEADER`。
  - `noteTicketSeen` / `checkTapAfterResponse(engine, ticket)`：在 `after_provider_response` 对铸造的票据调用即可触发 tap lost；`markTapLost` 可单独调用。
  - `persist(engine, epoch, op)` / `persistAllowed` / `leaseOf`：写后账本和每 tick 预算可以替换 op 的执行时机，闸口语义不变。
  - `engine.counters` 可扩展，用于 `droppedRows`、`busyBackoffs`、`maxStmtMs`、`unattributed*`。
  - `engine.corr` / `engine.gate` 是要被替换的组件。
  - `engine.cancel` 供流捕获使用。
  - `wireTraffic` 的 `childPersist` 对应 `traffic.childSessions`。
- **T3**
  - `wireTrafficHost(pi, {enabled, owner, isActive})` 和 `wireTrafficChild(pi, {enabled, isActive, childPersist})`。
  - `owner` 与 claim.token 是同一个对象；`isActive` 就是认领端口（claim.isLive），为假时钩子和命令都失效（mode-gate 有测试）。
- **T4**
  - `createTrafficServer(engine)` 内部，加固点有 `isAuthorized`、`handleHttp`、安全头和 `accessUrls`。
  - 连接账本 `engine.connections`。
  - 页面缓存 `engine.page`。
  - `TrafficModeError` 已在 HTTP 层映射为 403。

## 7. 自验输出

```
$ npx vitest run tests/traffic tests/integration/traffic-lifecycle-process.test.ts --maxWorkers=2
 Test Files  19 passed (19)
      Tests  209 passed (209)        # 迁入 160 + 新增 49（engine 9 / tap 10 / mode-gate 9 / legacy-dir 7 / db-path 3 / secure +4 / jq +1 / 集成 6）
   Duration  5.16s

$ npm run typecheck
  tsc -p tsconfig.json            ✓
  tsc -p tsconfig.typecheck.json  ✓
  vue-tsc (web-hub UI)            ✗ src/web-hub/ui/src/logic/previewLineIndex.ts(30,10): '"@logic/highlight.js"' has no exported member 'decodeHighlightSpans'
                                    —— 这是未跟踪文件（?? 状态），属于并行进行的 web-hub 工作，与本包无关，没有改动

$ npx prettier --check src/traffic tests/traffic tests/integration/traffic-lifecycle-process.test.ts
All matched files use Prettier code style!

$ git grep -n "traffic/" -- src ':!src/traffic'
（空，rc=1）
```

## 8. 遗留问题

- vue-tsc 失败来自他人的未跟踪文件 `previewLineIndex.ts`。它会让 `npm run typecheck` 整体退出码非 0，需要该工作的负责人处理。
- 第 5 节第 9 条：secure P2 必须先于本包提交，或与本包一起提交。
- tap lost 目前只能经 `checkTapAfterResponse` 判定，需要 T2b 铸造票据后才会自动触发。
- 集成测试的子进程从 4177 起绑端口（被占用则自增，最多 20 次）。本机若同时开着 20 个以上的录制服务会失败（极端情况）。

## §安全评审修复（gpt-6.1-sol reject：2 Blocker + 2 Major，`/tmp/traffic-T2a-secreview.json`）

每条修复都配了回归测试。用于验证的手段是：把修复点临时还原（用 sed 去掉对应语句，或重建旧的控制流），确认新测试在修复前失败、修复后通过；验证完已恢复。

| #   | 严重度  | 问题                                                                                                                                                | 修复落点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 回归测试（修复前失败）                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 只有录制路径进入 ALS；停录和 secure 透传绕过重入守卫；退役路径在重入检查**之前**就返回。延迟绑定下游因此在 `/record off` 或 retained 退役后无限递归 | `src/traffic/tap.ts` wrapper 体：**重入检查放在入口第一步，先于任何 return**。ALS 的 store 改为 `TapCallContext {ids: 本异步调用链上已经过的 wrapper id 集合, fallback}`。退役、停录、secure、录制四条路径都 `als.run(派生上下文, …)` 再调下游。嵌套的多个 traffic wrapper 各自累加 id，互不误判                                                                                                                                                                                                             | `tests/traffic/tap.test.ts`「安全评审 #1」3 例：`/record off` 下的延迟绑定环、secure 透传、retained 退役（F→w→L→F→w⇒N）。修复前全部递归失败                                                                                                                                                                                                                                              |
| 2   | Major   | `nativeFetch` 只是首次安装时的全局函数，可能本身就是延迟绑定的第三方 wrapper；回退出口又回到环中，同样没有出口                                      | 同一 wrapper：重入时把上下文标记为 `fallback:true` 再调 `nativeFetch`。**回退途中再次重入**就证明没有安全出口，此时按 §5.2 tap lost 规则调 `markTapLost(engine,"fetch-loop")`（停录、退役还原、notify 一次），并抛 `TrafficFetchLoopError`（`E_TRAFFIC_FETCH_LOOP`），让本次请求有界失败，计数 `loopFailures`。`markTapLost` 改为停录和退役每次都执行，只有通知去重                                                                                                                                          | `tap.test.ts`「安全评审 #2」2 例：**第三方延迟绑定 wrapper 先加载、再首次安装**（录制态和停录态各一）⇒ 断言有界失败、tap lost、`globalThis.fetch` 还原为 L、之后请求经 L→N 正常。修复前递归失败                                                                                                                                                                                          |
| 3   | Blocker | chunk INSERT 抛错被吞后，代码不取消 reader 却注销了取消域；重放的 `finally(finish)` 又注销了 controller 和截止，存活的上游失去所有清理入口          | `src/traffic/capture.ts` `captureStream`：区分自然 EOF（`eof` 标志）与其它退出。**非 EOF 时先 `cancelReader()`（只触发不等待），再注销**；新增 `opts.onEnd("eof"\|"aborted")`；早退路径（secure 或已关闭时取消 body；无 body 视为 eof）同样回调。`src/traffic/server.ts` 重放：响应头之后整段改为异常安全作用域，`settle(kind)` 规定**非 eof 一律先 `abort()` 再 `finish()`**。切点 ③ 拒绝、status UPDATE 抛错（catch 里先 settle、取消 body，再重抛）、流式落库抛错都走 settle；只有自然 EOF 才不中止就注销 | `tests/traffic/replay-cleanup.test.ts` 5 例：①stream_chunks INSERT 触发器报错 ⇒ 上游 2s 内被中止、取消域清空（**修复前失败**）；②status UPDATE 报错 ⇒ 上游被中止；③正常流式重放中 `engine.close` ⇒ 上游被中止；④captureStream 落库报错 ⇒ reader 被取消、`onEnd` 报 aborted；⑤自然 EOF 不取消。集成测试新增真子进程用例「流式落库抛错」：shutdown 之前上游就被中止，quit 后 3s 内自然退出 |
| 4   | Major   | `startServer` 没有对启动中的调用做 single-flight：并发 `/record on` 会监听两个端口，后者覆盖 `engine.server`，close 只关掉其中一个                  | `server.ts`：`startServer()` 改为每 engine single-flight（`engine.serverStarting` 共享 promise，跨同一 engine 的多个 `createTrafficServer` 实例同样共享）。每个创建过的 listener 登记进 `engine.listeners`（`close` 事件时移除）；启动中被关闭的实例经 `close` 事件结束本轮，启动 promise 一定会 settle。`engine.ts` close：关闭 `listeners ∪ server` **全部**实例，等每个 close 回调（有界 1s），账本同步清空                                                                                               | `tests/traffic/server-start.test.ts` 3 例：并发两次 `startServer` ⇒ 同一端口、只有 1 个 listener、相邻端口未被占用、close 后端口可重新绑定；启动中 close ⇒ 不留 listener、4177 可绑定；并发两次 `/record on` ⇒ 两条回复同一端口，reload 后端口释放。修复前 3 例全部失败                                                                                                                  |

**其它更正**：§5 第 9 条已过时，`src/secure/domain.ts` 现在已被 git 跟踪（`git ls-files` 确认），不再构成提交顺序的约束。

**附带的测试工程说明**：`replay-cleanup.test.ts` 用 `http.request({agent:false})` 发重放请求。原因是每个用例的服务都从 4177 起绑，undici 的连接池可能复用上一个用例已被 engine.close 销毁的 socket，从而出现 `fetch failed`。这是测试侧的连接复用问题，不是产品缺陷。

**残留**：

- **重入守卫的副作用**：被判为重入的请求会改走 `nativeFetch`。下游在本异步链内另行发起的独立 fetch（例如令牌刷新）也会被视为重入，绕过它的第三方层。这与 §13-7 一致，可通过计数和日志观察。
- **环路无安全出口时请求会失败**：本次请求以 `E_TRAFFIC_FETCH_LOOP` 失败，拦截层随即停用；用户在同一加载顺序下再次 `/record on`，会在下一次请求时再次有界失败并停用。

### 修复后自验

```
$ npx vitest run tests/traffic tests/integration/traffic-lifecycle-process.test.ts --maxWorkers=2
 Test Files  21 passed (21)
      Tests  223 passed (223)      # 原 209 + tap 5 + replay-cleanup 5 + server-start 3 + 集成 1
   Duration  5.47s
$ npx tsc --noEmit -p tsconfig.json        ✓
$ npx tsc --noEmit -p tsconfig.build.json  ✓
$ npx prettier --check src/traffic tests/traffic tests/integration/traffic-lifecycle-process.test.ts
All matched files use Prettier code style!
$ git grep -n "traffic/" -- src ':!src/traffic'   （空）
```
